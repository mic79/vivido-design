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
// for the Supertonic text-to-speech pipeline; the Whisper ASR API is unchanged.
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
    // TTS engine: 'kokoro' (Kokoro-82M, fast on GPU) or 'supertonic' (Supertonic 2
    // via transformers.js, fast on CPU/WASM → no GPU contention; quality/speed dial
    // = `steps`, the "5-step" Supertonic setting).
    engine = 'kokoro',
    modelId = (engine === 'supertonic'
      ? 'onnx-community/Supertonic-TTS-2-ONNX'
      : 'onnx-community/Kokoro-82M-v1.0-ONNX'),
    // Kokoro: fp16 on WebGPU is correct AND fast. (q8 on WebGPU is the trap: it
    // loads but the onnxruntime-web WebGPU backend mis-runs uint8 ops → slow +
    // garbled. The worker forces fp16 on GPU and q8 only on CPU.) Supertonic ships
    // fp32 only and runs on WASM/CPU.
    dtype = (engine === 'supertonic' ? 'fp32' : 'fp16'),
    device = (engine === 'supertonic' ? 'wasm' : 'webgpu'),
    voice = (engine === 'supertonic' ? 'F1' : 'af_heart'),
    steps = 5,        // Supertonic denoising steps (5 = fast, 12 = best quality)
    speed = 1.0,      // Supertonic speech speed factor
    spatial = true,
    position = { x: 0, y: 1.6, z: -1.8 },
    chunkChars = 140, // synth chunk size: smaller = first audio sooner (streaming)
  } = {}) {
    this.cfg = { engine, modelId, device, dtype, voice, steps, speed };
    this.voice = voice;
    this.chunkChars = chunkChars;
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
    else { this._tts = null; }
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
    else { this._tts = null; }
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
    } else if (this.cfg.engine === 'supertonic') {
      const out = await this._tts(clean, {
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
  async speak(text, { force = false } = {}) {
    if ((!this.enabled && !force) || !text || !text.trim()) return;
    if (!this.ready) await this.load();
    await this.unlock();
    const myGen = ++this._gen; // lets stop()/a newer speak() cancel this run
    const chunks = splitForSynth(text, this.chunkChars);
    const buffers = [];
    for (const chunk of chunks) {
      const buf = await this._synth(chunk);
      if (this._gen !== myGen) return; // superseded/stopped while synthesizing
      if (buf) { buffers.push(buf); this._enqueue(buf); }
      // Yield a macrotask so the WebXR compositor can present a frame between
      // GPU synth jobs (reduces the stutter during long replies).
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
