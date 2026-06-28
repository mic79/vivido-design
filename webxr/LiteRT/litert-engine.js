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
    if (modelFile || modelBuffer) {
      // In-memory load — most reliable (no CORS/auth). Best for VR/offline.
      let buffer = modelBuffer;
      if (modelFile) {
        report('reading-file', { name: modelFile.name, size: modelFile.size });
        buffer = await readFileWithProgress(modelFile, (loaded, total) =>
          report('reading-file', { loaded, total })
        );
      }
      baseOptions.modelAssetBuffer = new Uint8Array(
        buffer instanceof Uint8Array ? buffer.buffer : buffer
      );
    } else if (modelUrl && !buffered) {
      // Let the runtime stream the file itself (modelAssetPath). Uses far less
      // memory than buffering a ~2 GB file in JS — important on Quest/mobile.
      report('downloading', { url: modelUrl, streaming: true });
      baseOptions.modelAssetPath = modelUrl;
    } else if (modelUrl) {
      report('downloading', { url: modelUrl });
      // Stream the download so we can show progress, then hand over a buffer.
      const buffer = await fetchWithProgress(modelUrl, (loaded, total) =>
        report('downloading', { url: modelUrl, loaded, total })
      );
      baseOptions.modelAssetBuffer = new Uint8Array(buffer);
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
    this.llm = await LlmInference.createFromOptions(this.genai, createOpts);

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

function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsArrayBuffer(file);
  });
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
