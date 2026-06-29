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

// CDN module sources (pinned for reproducibility). transformers.js 4.x is needed
// for the Supertonic 2 text-to-speech pipeline; the Whisper ASR API is unchanged.
// Supertonic 3 lives in ./supertonic3.js (its own ONNX-Runtime-Web pipeline).
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
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

// vosk-browser (Kaldi/WASM ASR) — loaded as a global UMD bundle via a <script>
// tag. It manages its OWN web worker + WASM internally, so it runs on the CPU
// off the render thread (no GPU contention with the LLM/compositor), the same
// engine languageVR uses. Pinned to match languageVR's working version.
const VOSK_URL = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js';
let _voskLib = null;
function importVosk() {
  if (typeof window !== 'undefined' && window.Vosk) return Promise.resolve(window.Vosk);
  if (_voskLib) return _voskLib;
  _voskLib = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = VOSK_URL;
    s.async = true;
    s.onload = () => (window.Vosk ? resolve(window.Vosk) : reject(new Error('vosk-browser loaded but window.Vosk missing')));
    s.onerror = () => { _voskLib = null; reject(new Error('Failed to load vosk-browser from CDN')); };
    document.head.appendChild(s);
  });
  return _voskLib;
}

// Per-language Vosk models (gzipped-tar Kaldi models). CORS applies to the
// vosk worker's fetch, so models must be same-origin (or CORS-enabled).
//   - 'nl' reuses the model already bundled in the sibling languageVR project
//     (same dev-server origin → no CORS, works out of the box).
//   - everything else expects a small model dropped in ./models/vosk/<code>.tar.gz
//     (download e.g. vosk-model-small-<code>-*.zip from alphacephei.com/vosk/models,
//      the .zip works directly — no need to repackage).
const VOSK_LANGS = new Set(['en', 'nl', 'fr', 'de', 'es', 'it', 'pt', 'ru']);
function voskModelUrl(lang) {
  // vosk-browser fetches the model from inside ITS worker, so relative URLs would
  // resolve against the CDN, not this page → must hand it an absolute URL.
  const rel = (lang === 'nl')
    ? '../languageVR/assets/vosk-models/nl.tar.gz'
    : `./models/vosk/${lang}.tar.gz`;
  try {
    const base = (typeof window !== 'undefined' && window.location && window.location.href) || '';
    return base ? new URL(rel, base).href : rel;
  } catch (_) { return rel; }
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

/**
 * Fully tear down the shared voice worker, freeing ALL its memory (ASR + TTS
 * models + the WASM heap). Use this to reclaim RAM before loading a big LLM on
 * memory-tight devices (Quest). The next voice call lazily spawns a fresh
 * worker; callers should also unload() their Transcriber/SpatialSpeaker so they
 * re-warm. No-op if no worker is running.
 */
export function disposeVoiceWorker() {
  if (_vw) { try { _vw.terminate(); } catch (_) {} }
  for (const [, p] of _vwPending) { try { p.reject(new Error('Voice worker disposed')); } catch (_) {} }
  _vwPending.clear();
  _vw = null;
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

/**
 * Split text into synthesis chunks (~sentence-sized, merged up to `target`
 * chars). Smaller GPU jobs keep the WebXR compositor from freezing during a big
 * one-shot synth, and let the first chunk start playing sooner — while the queue
 * still plays them back-to-back with no audible gaps.
 */
export function splitForSynth(text, target = 160) {
  const clean = (text || '').trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?。！？\n]+[.!?。！？]*\s*/g) || [clean];
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    const piece = p.trim();
    if (!piece) continue;
    if (buf && (buf.length + 1 + piece.length) > target) { chunks.push(buf); buf = piece; }
    else buf = buf ? `${buf} ${piece}` : piece;
  }
  if (buf) chunks.push(buf);
  return chunks;
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
  constructor({ engine = 'whisper', modelId = 'onnx-community/whisper-tiny', device = 'wasm', dtype = 'fp32', language = null } = {}) {
    this.engine = engine;     // 'whisper' (Transformers.js) | 'vosk' (vosk-browser)
    this.cfg = { modelId, device, dtype };
    this.language = language;  // null = auto-detect (Whisper only); or e.g. 'en', 'nl'
    this.ready = false;
    this._warmed = false;
    this._useWorker = workerSupported();
    this._asr = null;  // inline whisper pipeline (only if Workers unavailable)
    this._vosk = null; // { model, recognizer, lang } when engine === 'vosk'
    this._voskOnResult = null; // active per-transcription result sink
  }

  static isSupported() { return MicRecorder.isSupported(); }

  async load() {
    if (this.ready) return this;
    if (this.engine === 'vosk') {
      await this._loadVosk();
    } else if (this._useWorker) {
      await vwCall('warm-asr', { cfg: this.cfg });
    } else {
      const { pipeline } = await importTransformers();
      this._asr = await pipeline('automatic-speech-recognition', this.cfg.modelId,
        { device: this.cfg.device, dtype: this.cfg.dtype });
    }
    this.ready = true;
    return this;
  }

  // Resolve the requested language to a Vosk model we can load (Vosk models are
  // per-language; there's no auto-detect, so fall back to English).
  _voskLang() {
    const l = (this.language || '').slice(0, 2).toLowerCase();
    return VOSK_LANGS.has(l) ? l : 'en';
  }

  async _loadVosk() {
    const Vosk = await importVosk();
    const lang = this._voskLang();
    const model = await Vosk.createModel(voskModelUrl(lang));
    const recognizer = new model.KaldiRecognizer(TARGET_SR);
    try { recognizer.setWords(false); } catch (_) {}
    recognizer.on('result', (m) => {
      const t = (m && m.result && m.result.text) || (m && m.text) || '';
      if (this._voskOnResult) this._voskOnResult(t.trim());
    });
    this._vosk = { model, recognizer, lang };
  }

  _disposeVosk() {
    try { this._vosk && this._vosk.recognizer && this._vosk.recognizer.remove(); } catch (_) {}
    try { this._vosk && this._vosk.model && this._vosk.model.terminate(); } catch (_) {}
    this._vosk = null;
    this._voskOnResult = null;
  }

  /** Download + instantiate the model so first real use isn't slow. */
  async warmup() {
    if (this._warmed) return this;
    await this.load();
    this._warmed = true;
    return this;
  }

  /** Mark the model as unloaded so the next use re-warms (after the shared
   *  worker was disposed to free memory). */
  unload() {
    this.ready = false; this._warmed = false; this._asr = null;
    if (this._vosk) this._disposeVosk();
  }

  /** Switch the ASR model (e.g. whisper-tiny -> whisper-base) at runtime. Drops
   *  the old model in the worker so the next use loads the new one. */
  async setModel(modelId) {
    if (this.engine === 'whisper' && this.cfg.modelId === modelId) return;
    this.engine = 'whisper';
    this.cfg.modelId = modelId;
    this.ready = false; this._warmed = false; this._asr = null;
    if (this._vosk) this._disposeVosk();
    if (this._useWorker) { try { await vwCall('reset-asr'); } catch (_) {} }
  }

  /** Switch the ASR engine ('whisper' | 'vosk'), optionally with a whisper model.
   *  Tears down the previous engine's resources so the next use loads cleanly. */
  async setEngine({ engine, modelId } = {}) {
    const nextEngine = engine || this.engine;
    const nextModel = (nextEngine === 'whisper' && modelId) ? modelId : this.cfg.modelId;
    if (nextEngine === this.engine && nextModel === this.cfg.modelId) return;
    // Tear down whatever is currently loaded.
    if (this.engine === 'vosk') this._disposeVosk();
    else if (this._useWorker) { try { await vwCall('reset-asr'); } catch (_) {} }
    this.engine = nextEngine;
    this.cfg.modelId = nextModel;
    this.ready = false; this._warmed = false; this._asr = null;
  }

  /** Set the recognition language (null = Whisper auto-detect). For Vosk this
   *  may require loading a different per-language model, so drop the current one
   *  if it no longer matches. */
  async setLanguage(language) {
    this.language = language;
    if (this.engine === 'vosk' && this._vosk && this._vosk.lang !== this._voskLang()) {
      this._disposeVosk();
      this.ready = false; this._warmed = false;
    }
  }

  /** Run vosk-browser on a recorded clip (one-shot): feed the audio + a short
   *  tail of silence to force end-of-utterance, accumulate the result segments,
   *  and settle shortly after the last one. */
  _voskTranscribe(data) {
    return new Promise((resolve) => {
      const token = {};
      this._voskActive = token;
      const parts = [];
      let settle = null;
      const finish = () => {
        if (this._voskActive !== token) return;
        this._voskActive = null;
        this._voskOnResult = null;
        clearTimeout(settle); clearTimeout(hard);
        resolve(collapseRepeats(parts.join(' ').replace(/\s+/g, ' ').trim()));
      };
      this._voskOnResult = (text) => {
        if (this._voskActive !== token) return;
        if (text) parts.push(text);
        clearTimeout(settle);
        settle = setTimeout(finish, 350);
      };
      const hard = setTimeout(finish, 6000); // safety net if no 'result' fires
      try {
        this._vosk.recognizer.acceptWaveformFloat(data, TARGET_SR);
        // ~0.5 s of silence nudges Kaldi to emit the final 'result'.
        this._vosk.recognizer.acceptWaveformFloat(new Float32Array(Math.round(TARGET_SR * 0.5)), TARGET_SR);
      } catch (_) { /* fall through to the timeout */ }
    });
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

    if (this.engine === 'vosk') {
      return this._voskTranscribe(new Float32Array(data0));
    }

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
    // TTS engine:
    //   'kokoro'      — Kokoro-82M, fast on GPU.
    //   'supertonic'  — Supertonic 2 (transformers.js pipeline), CPU/WASM, en/ko/
    //                   es/pt/fr. quality/speed dial = `steps`.
    //   'supertonic3' — Supertonic 3 (./supertonic3.js ONNX-Runtime-Web port),
    //                   CPU/WASM, 31 languages incl. Dutch + Italian.
    engine = 'kokoro',
    modelId = (engine === 'supertonic3'
      ? 'Supertone/supertonic-3'
      : engine === 'supertonic'
        ? 'onnx-community/Supertonic-TTS-2-ONNX'
        : 'onnx-community/Kokoro-82M-v1.0-ONNX'),
    // Kokoro: fp16 on WebGPU is correct AND fast. (q8 on WebGPU is the trap: it
    // loads but the onnxruntime-web WebGPU backend mis-runs uint8 ops → slow +
    // garbled. The worker forces fp16 on GPU and q8 only on CPU.) Supertonic ships
    // fp32 only and runs on WASM/CPU.
    dtype = (engine.startsWith('supertonic') ? 'fp32' : 'fp16'),
    device = (engine.startsWith('supertonic') ? 'wasm' : 'webgpu'),
    voice = (engine.startsWith('supertonic') ? 'F1' : 'af_heart'),
    steps = 5,        // Supertonic denoising steps (5 = fast, 12 = best quality)
    speed = 1.0,      // Supertonic speech speed factor
    lang = 'en',      // Supertonic language tag (v2: en/ko/es/pt/fr; v3: 31 langs)
    spatial = true,
    position = { x: 0, y: 1.6, z: -1.8 },
    chunkChars = 140, // synth chunk size: smaller = first audio sooner (streaming)
    leadChunks = 1,   // pre-synthesize this many chunks ahead before playback
                      // starts → a buffer that hides the per-sentence synth time
                      // (no idle gaps mid-reply when synth is slower than speech).
  } = {}) {
    this.cfg = { engine, modelId, device, dtype, voice, steps, speed, lang };
    this.voice = voice;
    this.chunkChars = chunkChars;
    this.leadChunks = leadChunks;
    this.spatial = spatial;
    this.position = position;
    this.enabled = true;
    this.ready = false;
    this._warmed = false;
    this._useWorker = workerSupported();
    this._tts = null; // inline fallback (only if Workers unavailable)
    this._st3 = null; // inline Supertonic 3 engine (only if Workers unavailable)

    this.ctx = null;
    this.panner = null;
    this.gain = null;
    this.queue = [];
    this.playing = false;
    this._starting = false;    // a start() is pending behind ctx.resume() (race guard)
    this.current = null;       // currently-playing AudioBufferSourceNode
    this.onPlaying = null;     // optional cb(isPlaying) for UI (stop button, etc.)
    this.onState = null;       // optional cb(audioContextState) for UI diagnostics
    this._gen = 0;             // bumped to cancel an in-flight chunked speak()
    this._lastText = '';       // cached reply text + audio for instant replay
    this._lastBuffers = null;
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

  /** Current AudioContext state ('running' | 'suspended' | 'closed' | 'none'). */
  audioState() { return this.ctx ? this.ctx.state : 'none'; }

  async load() {
    if (this.ready) return this;
    if (this._useWorker) {
      const r = await vwCall('warm-tts', { cfg: this.cfg });
      this.backend = (r && r.backend) || `${this.cfg.device}/${this.cfg.dtype}`;
    } else if (this.cfg.engine === 'supertonic3') {
      // Inline (no Worker): Supertonic 3 via our ONNX-Runtime-Web port on CPU.
      const { Supertonic3 } = await import(/* @vite-ignore */ './supertonic3.js');
      this._st3 = new Supertonic3({
        repo: this.cfg.modelId, voice: this.voice, lang: this.cfg.lang,
        steps: this.cfg.steps, speed: this.cfg.speed,
      });
      await this._st3.load();
      this._tts = this._st3;
      this.backend = this._st3.backend;
    } else if (this.cfg.engine === 'supertonic') {
      // Inline (no Worker): Supertonic via the transformers.js TTS pipeline on CPU.
      const { pipeline } = await importTransformers();
      this._tts = await pipeline('text-to-speech', this.cfg.modelId, { device: 'wasm', dtype: 'fp32' });
      this.backend = `supertonic wasm/fp32`;
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

  /**
   * Switch the synthesis backend at runtime (e.g. a CPU/GPU voice toggle). Stops
   * playback, drops the old model (freeing its memory) and reloads on next use.
   */
  async setBackend(device, dtype) {
    if (this.cfg.device === device && this.cfg.dtype === dtype) return;
    this.stop();
    this.cfg.device = device;
    this.cfg.dtype = dtype;
    this.ready = false;
    this._warmed = false;
    this.backend = '';
    this._lastText = '';
    this._lastBuffers = null;
    if (this._useWorker) { try { await vwCall('reset-tts'); } catch (_) {} }
    else { this._tts = null; this._st3 = null; }
  }

  /**
   * Switch the whole TTS engine at runtime (Kokoro <-> Supertonic, plus its
   * device/dtype/voice/steps). Stops playback, drops the old model and reloads
   * on next use. `cfg` may include { engine, modelId, device, dtype, voice,
   * steps, speed }.
   */
  async setEngine(cfg = {}) {
    const unchanged = ['engine', 'modelId', 'device', 'dtype'].every(
      (k) => cfg[k] === undefined || cfg[k] === this.cfg[k]);
    Object.assign(this.cfg, cfg);
    if (cfg.voice) this.voice = cfg.voice;
    if (unchanged && this.ready) return; // only voice/steps/speed tweaked
    this.stop();
    this.ready = false;
    this._warmed = false;
    this.backend = '';
    this._lastText = '';
    this._lastBuffers = null;
    if (this._useWorker) { try { await vwCall('reset-tts'); } catch (_) {} }
    else { this._tts = null; this._st3 = null; }
  }

  /** Drop the loaded TTS model + cached audio so the next use re-warms (after
   *  the shared worker was disposed to free memory for a big LLM). Keeps the
   *  audio graph/context so spatial playback still works afterwards. */
  unload() {
    this.stop();
    this.ready = false; this._warmed = false; this.backend = '';
    this._lastText = ''; this._lastBuffers = null;
    this._st3 = null; this._tts = null;
  }

  _initAudioGraph() {
    if (this.ctx) return; // build the graph once
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    // Surface context state changes (running / suspended) so the UI can show
    // whether audio is actually alive — there's no console in the headset.
    this.ctx.onstatechange = () => { if (typeof this.onState === 'function') { try { this.onState(this.ctx.state); } catch (_) {} } };
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
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
    } else if (this.cfg.engine === 'supertonic3') {
      const out = await this._st3.synth(clean, {
        voice: this.voice, lang: this.cfg.lang,
        steps: this.cfg.steps, speed: this.cfg.speed,
      });
      data = out.audio; rate = out.rate || 44100;
    } else if (this.cfg.engine === 'supertonic') {
      // Supertonic 2 needs a language tag ("<en>...</en>") or it garbles/repeats.
      const lang = this.cfg.lang || 'en';
      const tagged = /^\s*<[a-z]{2}>/i.test(clean) ? clean : `<${lang}>${clean}</${lang}>`;
      const out = await this._tts(tagged, {
        speaker_embeddings: `https://huggingface.co/${this.cfg.modelId}/resolve/main/voices/${this.voice}.bin`,
        num_inference_steps: this.cfg.steps || 5,
        speed: this.cfg.speed || 1.0,
      });
      data = out.audio || out.data;
      rate = out.sampling_rate || out.sampleRate || 44100;
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
    if (this._starting) return; // a start() is already pending behind resume()
    if (!this.queue.length) { this.current = null; this._setPlaying(false); return; }
    // Reserve the player SYNCHRONOUSLY. Otherwise, when the context is suspended
    // (common on Quest), each rapid _enqueue() — fast CPU synth queues several at
    // once — would schedule its own resume().then(start), and when resume()
    // resolves ALL of them fire together and play on top of each other. Setting
    // `playing` now makes _enqueue's guard skip re-triggering.
    this._setPlaying(true);
    const start = () => {
      this._starting = false;
      if (!this.queue.length) { this.current = null; this._setPlaying(false); return; }
      const buf = this.queue.shift();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      this.current = src;
      src.onended = () => { if (this.current === src) this.current = null; this._playNext(); };
      try { src.start(); } catch (_) {}
    };
    // A source started on a suspended context is silent and never fires onended
    // (the clock is frozen) — the classic "shows Speaking but no sound". Make
    // sure the context is running first.
    if (this.ctx.state !== 'running') {
      this._starting = true;
      this.ctx.resume().then(start).catch(start);
    } else {
      start();
    }
  }

  /**
   * Create the audio graph and resume the AudioContext. MUST be called from a
   * real user gesture (button press / controller select). On Quest, generation
   * can take several seconds, so the click's transient activation expires before
   * speak() runs — if we only resume() then, the context stays suspended and
   * there's NO SOUND. Calling unlock() up-front on the gesture fixes that.
   */
  async unlock() {
    this._initAudioGraph();
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (_) {}
    }
  }

  /**
   * Synthesize + speak a full string. The text is split into ~sentence chunks
   * that are synthesized in order and queued back-to-back (gapless), so the
   * first words start sooner and each GPU job is small enough not to freeze the
   * VR render. The synthesized buffers are cached so replay() needs no re-synth.
   * Pass { force: true } to speak even when `enabled` is off.
   */
  async speak(text, { force = false, lead = this.leadChunks } = {}) {
    if ((!this.enabled && !force) || !text || !text.trim()) return;
    if (!this.ready) await this.load();
    await this.unlock();
    const myGen = ++this._gen; // lets stop()/a newer speak() cancel this run
    const chunks = splitForSynth(text, this.chunkChars);
    const buffers = [];
    let started = false; // has playback begun for this reply yet?
    for (let i = 0; i < chunks.length; i++) {
      const buf = await this._synth(chunks[i]);
      if (this._gen !== myGen) return; // superseded/stopped while synthesizing
      if (buf) {
        buffers.push(buf);
        this.queue.push(buf);
        // Pre-buffer: don't start until we're `lead` chunks ahead (or this is the
        // last chunk). After playback has begun, immediately resume if it stalled
        // (queue drained because synth fell behind) — that's the gap we're fixing.
        const isLast = (i === chunks.length - 1);
        if (!this.playing) {
          if (!started) {
            if (this.queue.length > lead || isLast) { started = true; this._playNext(); }
          } else {
            this._playNext();
          }
        }
      }
      // Yield a macrotask so the WebXR compositor can present a frame between
      // synth jobs (reduces the stutter during long replies).
      await new Promise((r) => setTimeout(r, 0));
      if (this._gen !== myGen) return;
    }
    this._lastText = text;
    this._lastBuffers = buffers;
  }

  /**
   * Replay a reply WITHOUT re-synthesizing when it's the one we just spoke:
   * re-queues the cached audio buffers (instant, no GPU). Falls back to a fresh
   * synth only for text we don't have cached.
   */
  async replay(text) {
    await this.unlock();
    if (text && this._lastText === text && this._lastBuffers && this._lastBuffers.length) {
      this._gen++; // take over playback
      for (const b of this._lastBuffers) this._enqueue(b);
      return true;
    }
    await this.speak(text, { force: true });
    return false;
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

  /** Stop playback immediately and clear the queue (keeps the context running so
   *  the next reply still has sound — do NOT suspend here). */
  stop() {
    this._gen++; // cancel any in-flight chunked synth
    this.queue = [];
    this._starting = false; // drop any start() pending behind a resume()
    try { if (this.current) { this.current.onended = null; this.current.stop(); } } catch (_) {}
    this.current = null;
    this._setPlaying(false);
  }

  async listVoices() {
    try { return this._tts && this._tts.list_voices ? this._tts.list_voices() : []; } catch { return []; }
  }
}
