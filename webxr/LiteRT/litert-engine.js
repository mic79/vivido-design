// litert-engine.js
// Reusable on-device LLM engine for the LiteRT-LM web runtime (MediaPipe GenAI).
//
// This is the piece you drop into other projects (languageVR, BattleVR, ...).
// It is environment-agnostic: it only touches the LLM runtime, never the DOM or
// A-Frame, so it works identically in a flat web page and inside a WebXR scene.
//
// Usage:
//   import { LiteRTEngine } from './litert-engine.js';
//   import { getPreset } from './models.js';
//
//   const engine = new LiteRTEngine();
//   if (!(await LiteRTEngine.isSupported())) { /* show WebGPU warning */ }
//   await engine.load({ preset: getPreset('gemma3-1b-web'),
//                       modelFile: fileFromPicker,         // OR
//                       modelUrl: 'https://.../model.task', // OR preset.url
//                       onProgress: (p) => console.log(p) });
//
//   const text = await engine.generate('Hello!', {
//     system: 'You are a helpful Dutch tutor.',
//     onToken: (delta, full) => updateUI(full),
//   });
//
// Pin the package version for reproducibility. 0.10.27 is the current stable.

import { TEMPLATES } from './models.js';

const TASKS_GENAI_VERSION = '0.10.27';
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@${TASKS_GENAI_VERSION}/wasm`;
const ESM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@${TASKS_GENAI_VERSION}`;

let _mp = null;
async function importMediaPipe() {
  if (!_mp) _mp = await import(/* @vite-ignore */ ESM_URL);
  return _mp;
}

export class LiteRTEngine {
  constructor(opts = {}) {
    this.llm = null;
    this.genai = null;
    this.preset = null;
    this.busy = false;
    this.ready = false;
    this.audioEnabled = false; // true when the model was loaded with supportAudio
    this.options = {
      maxTokens: 1024,
      temperature: 0.8,
      topK: 40,
      randomSeed: 101,
      ...opts,
    };
    // Conversation memory used to rebuild the full prompt each turn.
    this.history = [];
  }

  /** True if this browser exposes WebGPU (required by the runtime). */
  static async isSupported() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch {
      return false;
    }
  }

  /** Human-readable reason WebGPU may be unavailable, for UI messaging. */
  static unsupportedReason() {
    if (typeof navigator === 'undefined') return 'No browser environment.';
    if (!('gpu' in navigator)) {
      return 'WebGPU is not available. Use Chrome/Edge 121+ (desktop, Android) ' +
             'or a WebGPU-capable browser. On Quest, use the latest Meta Browser.';
    }
    return 'A WebGPU adapter could not be acquired (GPU blocklisted or disabled).';
  }

  /**
   * Load a model. Provide exactly one source: modelFile (File/Blob),
   * modelBuffer (ArrayBuffer/Uint8Array), or modelUrl (string). A preset may
   * supply the url and the template.
   */
  async load({ preset = null, modelFile = null, modelBuffer = null, modelUrl = null, buffered = true, audio = null, maxNumImages = 0, onProgress = null } = {}) {
    const report = (stage, detail = {}) => onProgress && onProgress({ stage, ...detail });

    if (!(await LiteRTEngine.isSupported())) {
      throw new Error(LiteRTEngine.unsupportedReason());
    }

    this.preset = preset;
    if (preset) {
      if (preset.maxTokens) this.options.maxTokens = preset.maxTokens;
      if (!modelFile && !modelBuffer && !modelUrl && preset.url) modelUrl = preset.url;
    }

    // Enable native audio input when explicitly requested, or when the preset
    // advertises multimodal audio (Gemma 3n / Gemma 4).
    this.audioEnabled = audio == null ? !!(preset && preset.audio) : !!audio;

    report('init-runtime');
    const { FilesetResolver, LlmInference } = await importMediaPipe();
    this.genai = await FilesetResolver.forGenAiTasks(WASM_ROOT);

    const baseOptions = {};
    if (modelFile) {
      // Stream the file straight into the runtime (disk -> WASM) instead of
      // reading the whole ~2 GB into a JS ArrayBuffer first. This keeps the JS
      // heap tiny, which is what prevents out-of-memory crashes on Quest when
      // loading a cached/picked model. (No CORS/auth concerns — it's local.)
      report('reading-file', { name: modelFile.name, size: modelFile.size, loaded: 0, total: modelFile.size });
      baseOptions.modelAssetBuffer = await streamFileReader(modelFile, (loaded, total) =>
        report('reading-file', { loaded, total, name: modelFile.name })
      );
    } else if (modelBuffer) {
      baseOptions.modelAssetBuffer = new Uint8Array(
        modelBuffer instanceof Uint8Array ? modelBuffer.buffer : modelBuffer
      );
    } else if (modelUrl) {
      // Download the model OURSELVES so we can (a) report real byte-level
      // progress and (b) hand the runtime a stream reader, which fills WASM
      // memory incrementally instead of buffering the whole ~2 GB file in the
      // JS heap. This is what keeps it from silently hanging on Quest/mobile.
      //
      // buffered:true forces a single in-memory ArrayBuffer (rarely needed).
      report('downloading', { url: modelUrl, streaming: true, loaded: 0, total: 0 });
      try {
        if (buffered === true) {
          const buffer = await fetchWithProgress(modelUrl, (loaded, total) =>
            report('downloading', { url: modelUrl, loaded, total }));
          baseOptions.modelAssetBuffer = new Uint8Array(buffer);
        } else {
          baseOptions.modelAssetBuffer = await streamModelReader(modelUrl, (loaded, total) =>
            report('downloading', { url: modelUrl, loaded, total, streaming: true }));
        }
      } catch (e) {
        throw new Error(
          `Could not download the model from the URL (${e.message || e}). ` +
          `Check the link, your connection, and that the host allows cross-origin ` +
          `(CORS) requests — gated files (e.g. some Hugging Face URLs) will be blocked. ` +
          `As a fallback, download the .task once and use the local-file loader.`
        );
      }
    } else {
      throw new Error('No model source provided (modelFile, modelBuffer or modelUrl).');
    }

    report('creating-session');
    const createOpts = {
      baseOptions,
      maxTokens: this.options.maxTokens,
      topK: this.options.topK,
      temperature: this.options.temperature,
      randomSeed: this.options.randomSeed,
      numResponses: 1, // web requires exactly 1
    };
    if (this.audioEnabled) createOpts.supportAudio = true;
    if (maxNumImages > 0) createOpts.maxNumImages = maxNumImages;
    try {
      this.llm = await LlmInference.createFromOptions(this.genai, createOpts);
    } catch (e) {
      // Some runtime/browser combos may not accept a stream reader. Fall back to
      // a concrete source (no progress, higher peak memory, but may still work).
      const usedReader = baseOptions.modelAssetBuffer &&
        !(baseOptions.modelAssetBuffer instanceof Uint8Array);
      if (usedReader && modelUrl) {
        report('creating-session', { fallback: true });
        delete baseOptions.modelAssetBuffer;
        baseOptions.modelAssetPath = modelUrl;
        this.llm = await LlmInference.createFromOptions(this.genai, { ...createOpts, baseOptions });
      } else if (usedReader && modelFile) {
        report('creating-session', { fallback: true });
        baseOptions.modelAssetBuffer = new Uint8Array(await modelFile.arrayBuffer());
        this.llm = await LlmInference.createFromOptions(this.genai, { ...createOpts, baseOptions });
      } else {
        throw e;
      }
    }

    this.ready = true;
    report('ready');
    return this;
  }

  /** Build the full templated prompt string from system + history + this turn. */
  buildPrompt(prompt, { system = '', includeHistory = true } = {}) {
    const templateName = (this.preset && this.preset.template) || 'gemma4';
    const tmpl = TEMPLATES[templateName] || TEMPLATES.gemma4;
    return tmpl({
      system,
      history: includeHistory ? this.history : [],
      prompt,
    });
  }

  /**
   * Generate a response. If onToken is supplied, streams deltas as they arrive.
   * Returns the full response text. Updates internal history for multi-turn.
   *
   * @returns {Promise<{text:string, ttftMs:number, totalMs:number, tokensApprox:number}>}
   */
  async generate(prompt, {
    system = '',
    onToken = null,
    includeHistory = true,
    remember = true,
  } = {}) {
    const fullPrompt = this.buildPrompt(prompt, { system, includeHistory });
    const res = await this._run(fullPrompt, onToken);
    if (remember) {
      this.history.push({ role: 'user', content: prompt });
      this.history.push({ role: 'model', content: res.text });
    }
    return res;
  }

  /**
   * Native multimodal generation: feed spoken audio straight into Gemma 3n /
   * Gemma 4 (no separate ASR). `audio` is a single-channel AudioBuffer (or a
   * mono audio file URL). `text` is an optional instruction shown alongside the
   * audio (e.g. "Answer the question in this clip."). Requires the model to
   * have been loaded with audio support.
   *
   * @returns same metrics shape as generate().
   */
  async generateFromAudio(audio, {
    text = '',
    system = '',
    onToken = null,
    includeHistory = true,
    remember = true,
  } = {}) {
    if (!this.ready || !this.llm) throw new Error('Engine not loaded. Call load() first.');
    if (!this.audioEnabled) {
      throw new Error('This model was not loaded with audio support. Load a Gemma 3n / Gemma 4 preset (audio: true).');
    }
    if (!audio) throw new Error('No audio provided.');

    // Build a multimodal prompt array: history text + open-turn + audio (+text)
    // + close-turn + model-open. The runtime concatenates strings and splices
    // the AudioBuffer in at its position.
    const tmpl = TEMPLATES[(this.preset && this.preset.template) || 'gemma4'] || TEMPLATES.gemma4;

    const query = [];
    // Prior turns + optional system as a leading text block (no trailing prompt).
    const lead = tmpl({ system, history: includeHistory ? this.history : [], prompt: '__LITERT_AUDIO__' });
    const [before, after] = lead.split('__LITERT_AUDIO__');
    query.push(before);          // ...<turn>user\n
    query.push(audio);           // <-- AudioBuffer
    if (text && text.trim()) query.push('\n' + text.trim());
    query.push(after);           // <close turn>\n<turn>model\n

    const res = await this._run(query, onToken);
    if (remember) {
      this.history.push({ role: 'user', content: text && text.trim() ? `[audio] ${text.trim()}` : '[audio message]' });
      this.history.push({ role: 'model', content: res.text });
    }
    return res;
  }

  /** Shared generation runner for both text and multimodal queries. */
  async _run(query, onToken) {
    if (!this.ready || !this.llm) throw new Error('Engine not loaded. Call load() first.');
    if (this.busy) throw new Error('Engine is busy with another generation.');
    this.busy = true;

    const t0 = performance.now();
    let ttft = -1;
    let full = '';

    try {
      if (onToken) {
        await new Promise((resolve, reject) => {
          try {
            this.llm.generateResponse(query, (partial, done) => {
              if (partial) {
                if (ttft < 0) ttft = performance.now() - t0;
                full += partial;
                try { onToken(partial, full); } catch (_) {}
              }
              if (done) resolve();
            });
          } catch (e) {
            reject(e);
          }
        });
      } else {
        full = await this.llm.generateResponse(query);
        ttft = performance.now() - t0;
      }
    } finally {
      this.busy = false;
    }

    const totalMs = performance.now() - t0;
    full = cleanResponse(full);
    const tokensApprox = Math.max(1, Math.round(full.length / 4));
    return {
      text: full,
      ttftMs: ttft < 0 ? totalMs : ttft,
      totalMs,
      tokensApprox,
      tokensPerSec: tokensApprox / (totalMs / 1000),
    };
  }

  /** Clear multi-turn conversation memory (keeps the loaded model). */
  reset() {
    this.history = [];
  }

  /** Free the underlying runtime. */
  dispose() {
    try { this.llm && this.llm.close && this.llm.close(); } catch (_) {}
    this.llm = null;
    this.ready = false;
    this.history = [];
  }
}

// --- helpers ---------------------------------------------------------------

function cleanResponse(text) {
  if (!text) return '';
  // Drop any thinking-channel content (Gemma 4 may emit it on larger models).
  let out = text.replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '');
  // Strip stray Gemma 4 / Gemma 3 control tokens the model may echo.
  out = out
    .replace(/<\|turn>(system|user|model)?\n?/g, '')
    .replace(/<turn\|>/g, '')
    .replace(/<\|channel>|<channel\|>/g, '')
    .replace(/<end_of_turn>/g, '')
    .replace(/<start_of_turn>(user|model)?/g, '');
  return out.trim();
}

/**
 * Stream a File/Blob (e.g. from the OPFS cache or a file picker) into a
 * ReadableStreamDefaultReader the runtime can consume incrementally, so the
 * whole file is never resident in the JS heap. Reports (loaded, total) bytes.
 */
async function streamFileReader(file, onProgress) {
  if (!file.stream || typeof file.stream !== 'function') {
    const buf = await file.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }
  const total = file.size || 0;
  const src = file.stream().getReader();
  let loaded = 0;
  const progressed = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await src.read();
        if (done) { controller.close(); return; }
        loaded += value.byteLength;
        try { onProgress(loaded, total); } catch (_) {}
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { try { src.cancel(reason); } catch (_) {} },
  });
  return progressed.getReader();
}

/**
 * Fetch `url` and return a ReadableStreamDefaultReader that reports download
 * progress as the runtime pulls bytes from it. The whole file is never held in
 * the JS heap — chunks are consumed (and GC'd) by MediaPipe as it reads them,
 * which is essential for loading ~2 GB models on memory-constrained Quest.
 * Falls back to a Uint8Array if the browser can't stream the response body.
 */
async function streamModelReader(url, onProgress) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = await res.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const src = res.body.getReader();
  let loaded = 0;
  // Re-wrap in a fresh stream so getReader() returns a genuine
  // ReadableStreamDefaultReader (which MediaPipe type-checks for).
  const progressed = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await src.read();
        if (done) { controller.close(); return; }
        loaded += value.byteLength;
        try { onProgress(loaded, total); } catch (_) {}
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { try { src.cancel(reason); } catch (_) {} },
  });
  return progressed.getReader();
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Download failed (${res.status}). The file may be gated — try the local-file loader.`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return await res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}
