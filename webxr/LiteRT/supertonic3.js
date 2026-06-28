// supertonic3.js
// On-device Supertonic 3 text-to-speech (31 languages, incl. Dutch, French,
// Italian, Brazilian Portuguese) running fully in the browser on ONNX Runtime
// Web — no cloud, no server.
//
// WHY THIS EXISTS (and why it isn't a one-line transformers.js swap):
// Supertonic 1/2 ship a transformers.js-`pipeline()`-ready repo (onnx-community),
// but Supertonic 3 changed the architecture to a 4-graph flow-matching pipeline:
//
//     text  ->  [duration_predictor] -> per-token durations
//           ->  [text_encoder]       -> text embedding
//   noise   ->  [vector_estimator]   -> denoise N steps (the speed/quality dial)
//           ->  [vocoder]            -> waveform
//
// with a custom `unicode_indexer` tokenizer and `voice_styles/*.json` speaker
// styles. transformers.js has no built-in model class for that yet, so we drive
// the four ONNX graphs ourselves. This is a direct port of Supertone's official
// reference web implementation (github.com/supertone-inc/supertonic, web/).
//
// It runs on WASM/CPU on purpose: Supertonic is tuned for CPU and is fast there,
// and keeping it off WebGPU leaves the whole GPU for the LLM + the WebXR
// compositor (no stutter on Quest). Large weights are cached in the Cache API on
// first load, so later sessions start offline-fast.
//
// Usage (in a Worker or on the main thread):
//   const tts = new Supertonic3({ repo: 'Supertone/supertonic-3' });
//   await tts.load();                               // downloads + compiles graphs
//   const { audio, rate } = await tts.synth('Hallo, hoe gaat het?',
//                                            { voice: 'F1', lang: 'nl', steps: 8 });

// onnxruntime-web (WASM build, ESM) + matching wasm binaries, pinned for repro.
const ORT_VERSION = '1.22.0';
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.wasm.min.mjs`;
const ORT_WASM_DIR = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
// Cache API bucket for the (large) model weights so we download them only once.
const CACHE_NAME = 'supertonic3-v1';
// Official fp32 weights — the known-good fallback. ORT-Web's WASM backend can't
// run some quantized builds (e.g. int8 ConvInteger), so we recover to this.
const OFFICIAL_REPO = 'Supertone/supertonic-3';
const OFFICIAL_BASE = `https://huggingface.co/${OFFICIAL_REPO}/resolve/main`;

// The 31 languages Supertonic 3 supports (plus 'na' = no/neutral language tag).
export const SUPERTONIC3_LANGS = [
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr',
  'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk',
  'sl', 'sv', 'tr', 'uk', 'vi', 'na',
];

let _ort = null;
async function importOrt(numThreads) {
  if (_ort) return _ort;
  const ort = await import(/* @vite-ignore */ ORT_URL);
  // ORT needs to know where its .wasm/.mjs companions live (we load ORT from a
  // CDN, so point it back at that same CDN folder).
  ort.env.wasm.wasmPaths = ORT_WASM_DIR;
  try {
    const isolated = (typeof self !== 'undefined') && self.crossOriginIsolated;
    ort.env.wasm.numThreads = isolated ? Math.max(1, numThreads | 0) : 1;
  } catch (_) {}
  _ort = ort;
  return ort;
}

// Fetch a URL through the Cache API so big weights download only once. Returns a
// Uint8Array (what InferenceSession.create wants for in-memory models).
async function cachedBytes(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch (_) {}
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Supertonic 3: failed to fetch ${url} (HTTP ${res.status})`);
  if (cache) { try { await cache.put(url, res.clone()); } catch (_) {} }
  if (onProgress && res.body && res.headers.get('content-length')) {
    // Stream so the caller can show download progress on the very first load.
    const total = parseInt(res.headers.get('content-length'), 10);
    const reader = res.body.getReader();
    const parts = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      try { onProgress(received, total); } catch (_) {}
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function cachedJson(url) {
  // Small JSON (config / tokenizer / voice styles) — Cache API + parse.
  const bytes = await cachedBytes(url);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------
// Text -> token ids (port of Supertone's UnicodeProcessor, web build)
// ---------------------------------------------------------------------------
class UnicodeProcessor {
  constructor(indexer) { this.indexer = indexer; } // Array indexed by code point

  call(textList, langList) {
    const processed = textList.map((t, i) => this.preprocess(t, langList[i]));
    const lengths = processed.map((t) => t.length);
    const maxLen = Math.max(...lengths);
    const textIds = processed.map((text) => {
      const row = new Array(maxLen).fill(0);
      for (let j = 0; j < text.length; j++) {
        const cp = text.codePointAt(j);
        row[j] = (cp < this.indexer.length) ? this.indexer[cp] : -1;
      }
      return row;
    });
    return { textIds, textMask: this.lengthToMask(lengths, maxLen) };
  }

  preprocess(text, lang) {
    text = text.normalize('NFKD');
    // Strip emoji (TTS shouldn't try to read them).
    text = text.replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
    const repl = {
      '_': ' ', '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
      '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ',
    };
    for (const [k, v] of Object.entries(repl)) text = text.replaceAll(k, v);
    const expr = { '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ' };
    for (const [k, v] of Object.entries(expr)) text = text.replaceAll(k, v);
    text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!')
               .replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':')
               .replace(/ '/g, "'");
    while (text.includes('""')) text = text.replace('""', '"');
    while (text.includes("''")) text = text.replace("''", "'");
    text = text.replace(/\s+/g, ' ').trim();
    // Ensure terminal punctuation (helps the duration predictor end cleanly).
    if (!/[.!?;:,'")\]}]$/.test(text)) text += '.';
    const l = SUPERTONIC3_LANGS.includes(lang) ? lang : 'en';
    return `<${l}>${text}</${l}>`; // v3 REQUIRES the language tag wrapper
  }

  lengthToMask(lengths, maxLen) {
    return lengths.map((len) => {
      const row = new Array(maxLen).fill(0.0);
      for (let j = 0; j < Math.min(len, maxLen); j++) row[j] = 1.0;
      return [row]; // [1, maxLen] -> batched to [B,1,maxLen]
    });
  }
}

// Split a long string into <=maxLen sentence-ish chunks (port of reference).
function chunkText(text, maxLen) {
  const paragraphs = String(text).trim().split(/\n\s*\n+/).filter((p) => p.trim());
  const chunks = [];
  for (let para of paragraphs) {
    para = para.trim();
    if (!para) continue;
    const sentences = para.split(/(?<=[.!?])\s+/);
    let cur = '';
    for (const s of sentences) {
      if (cur.length + s.length + 1 <= maxLen) cur += (cur ? ' ' : '') + s;
      else { if (cur) chunks.push(cur.trim()); cur = s; }
    }
    if (cur) chunks.push(cur.trim());
  }
  return chunks.length ? chunks : [String(text).trim()];
}

// ---------------------------------------------------------------------------
// Supertonic 3 engine
// ---------------------------------------------------------------------------
export class Supertonic3 {
  constructor({
    repo = 'Supertone/supertonic-3', // any HF repo with the v3 onnx/ layout
    voice = 'F1',
    lang = 'en',
    steps = 8,        // vector-estimator denoising steps (fewer = faster)
    speed = 1.05,     // speech speed factor (>1 = faster speech)
    numThreads = 4,   // WASM threads (only used when cross-origin isolated)
  } = {}) {
    this.base = `https://huggingface.co/${repo}/resolve/main`;
    this.voice = voice;
    this.lang = lang;
    this.steps = steps;
    this.speed = speed;
    this.numThreads = numThreads;
    this.ready = false;
    this._styleCache = new Map();
    this.backend = '';
  }

  async load(onProgress) {
    if (this.ready) return this;
    const ort = await importOrt(this.numThreads);
    this._ort = ort;

    // Some quantized repos use ops the ORT-Web WASM backend can't run (most
    // notably ConvInteger from int8/QOperator builds → "Could not find an
    // implementation for ConvInteger"). If the requested repo fails to create a
    // session, fall back to the official fp32 weights, which ORT-Web runs (it's
    // what Supertone's reference web demo uses).
    try {
      await this._loadFrom(this.base, onProgress);
    } catch (err) {
      if (this.base !== OFFICIAL_BASE) {
        console.warn(`[supertonic3] ${this.base} failed (${err && err.message}); ` +
                     `falling back to fp32 ${OFFICIAL_REPO}`);
        this.base = OFFICIAL_BASE;
        this._styleCache.clear();
        await this._loadFrom(this.base, onProgress);
      } else {
        throw err;
      }
    }

    const threads = (typeof self !== 'undefined' && self.crossOriginIsolated)
      ? `x${ort.env.wasm.numThreads}` : '1-thread';
    const tag = (this.base === OFFICIAL_BASE) ? 'fp32' : 'quant';
    this.backend = `supertonic3 wasm/${tag} ${threads}`;
    this.ready = true;
    return this;
  }

  async _loadFrom(base, onProgress) {
    const ort = this._ort;
    this.cfgs = await cachedJson(`${base}/onnx/tts.json`);
    this.proc = new UnicodeProcessor(await cachedJson(`${base}/onnx/unicode_indexer.json`));
    this.sampleRate = this.cfgs.ae.sample_rate;

    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const graphs = [
      ['dp', 'duration_predictor.onnx'],
      ['enc', 'text_encoder.onnx'],
      ['vest', 'vector_estimator.onnx'],
      ['voc', 'vocoder.onnx'],
    ];
    let i = 0;
    for (const [key, file] of graphs) {
      i++;
      const bytes = await cachedBytes(`${base}/onnx/${file}`,
        onProgress ? (recv, total) => onProgress(file, i, graphs.length, recv, total) : null);
      this[key] = await ort.InferenceSession.create(bytes, opts);
    }
  }

  async _voiceStyle(voice) {
    if (this._styleCache.has(voice)) return this._styleCache.get(voice);
    const ort = this._ort;
    const j = await cachedJson(`${this.base}/voice_styles/${voice}.json`);
    const mk = (s) => new ort.Tensor('float32',
      Float32Array.from(s.data.flat(Infinity)), s.dims);
    const style = { ttl: mk(j.style_ttl), dp: mk(j.style_dp) };
    this._styleCache.set(voice, style);
    return style;
  }

  _sampleNoisyLatent(duration) {
    const ttl = this.cfgs.ttl;
    const chunkSize = this.cfgs.ae.base_chunk_size * ttl.chunk_compress_factor;
    const latentDim = ttl.latent_dim * ttl.chunk_compress_factor;
    const wavLenMax = Math.max(...duration) * this.sampleRate;
    const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);

    const bsz = duration.length;
    const xt = [];
    for (let b = 0; b < bsz; b++) {
      const batch = [];
      for (let d = 0; d < latentDim; d++) {
        const row = new Array(latentLen);
        for (let t = 0; t < latentLen; t++) {
          // Box–Muller -> standard normal noise.
          const u1 = Math.max(1e-10, Math.random());
          const u2 = Math.random();
          row[t] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        }
        batch.push(row);
      }
      xt.push(batch);
    }
    const wavLengths = duration.map((d) => Math.floor(d * this.sampleRate));
    const latentLengths = wavLengths.map((len) => Math.floor((len + chunkSize - 1) / chunkSize));
    const latentMask = latentLengths.map((len) => {
      const row = new Array(latentLen).fill(0.0);
      for (let t = 0; t < Math.min(len, latentLen); t++) row[t] = 1.0;
      return [row];
    });
    for (let b = 0; b < bsz; b++)
      for (let d = 0; d < latentDim; d++)
        for (let t = 0; t < latentLen; t++) xt[b][d][t] *= latentMask[b][0][t];
    return { xt, latentMask };
  }

  async _infer(text, lang, style, steps, speed, onStep) {
    const ort = this._ort;
    const { textIds, textMask } = this.proc.call([text], [lang]);
    const bsz = 1;

    const textIdsTensor = new ort.Tensor('int64',
      BigInt64Array.from(textIds.flat().map((x) => BigInt(x))), [bsz, textIds[0].length]);
    const textMaskTensor = new ort.Tensor('float32',
      Float32Array.from(textMask.flat(2)), [bsz, 1, textMask[0][0].length]);

    const dpOut = await this.dp.run({ text_ids: textIdsTensor, style_dp: style.dp, text_mask: textMaskTensor });
    const duration = Array.from(dpOut.duration.data).map((d) => d / speed);

    const encOut = await this.enc.run({ text_ids: textIdsTensor, style_ttl: style.ttl, text_mask: textMaskTensor });
    const textEmb = encOut.text_emb;

    let { xt, latentMask } = this._sampleNoisyLatent(duration);
    const latentDim = xt[0].length;
    const latentLen = xt[0][0].length;
    const latentShape = [bsz, latentDim, latentLen];
    const latentMaskTensor = new ort.Tensor('float32',
      Float32Array.from(latentMask.flat(2)), [bsz, 1, latentLen]);
    const totalStepTensor = new ort.Tensor('float32', new Float32Array(bsz).fill(steps), [bsz]);

    for (let step = 0; step < steps; step++) {
      if (onStep) { try { onStep(step + 1, steps); } catch (_) {} }
      const curStepTensor = new ort.Tensor('float32', new Float32Array(bsz).fill(step), [bsz]);
      const xtTensor = new ort.Tensor('float32', Float32Array.from(xt.flat(2)), latentShape);
      const vOut = await this.vest.run({
        noisy_latent: xtTensor, text_emb: textEmb, style_ttl: style.ttl,
        latent_mask: latentMaskTensor, text_mask: textMaskTensor,
        current_step: curStepTensor, total_step: totalStepTensor,
      });
      const denoised = vOut.denoised_latent.data;
      let idx = 0;
      for (let d = 0; d < latentDim; d++)
        for (let t = 0; t < latentLen; t++) xt[0][d][t] = denoised[idx++];
    }

    const finalTensor = new ort.Tensor('float32', Float32Array.from(xt.flat(2)), latentShape);
    const vocOut = await this.voc.run({ latent: finalTensor });
    return { wav: vocOut.wav_tts.data, duration };
  }

  /**
   * Synthesize speech. Returns { audio: Float32Array, rate }.
   * opts: { voice, lang, steps, speed, silence, onStep }
   */
  async synth(text, opts = {}) {
    if (!this.ready) await this.load();
    const voice = opts.voice || this.voice;
    const lang = SUPERTONIC3_LANGS.includes(opts.lang) ? opts.lang : this.lang;
    const steps = opts.steps || this.steps;
    const speed = opts.speed || this.speed;
    const silence = opts.silence != null ? opts.silence : 0.2;
    const style = await this._voiceStyle(voice);

    const maxLen = (lang === 'ko' || lang === 'ja') ? 120 : 300;
    const pieces = chunkText(text, maxLen);
    const segments = [];
    let totalLen = 0;
    const silenceLen = Math.floor(silence * this.sampleRate);
    for (let i = 0; i < pieces.length; i++) {
      const { wav, duration } = await this._infer(pieces[i], lang, style, steps, speed, opts.onStep);
      // Vocoder pads the tail; trim to the predicted duration.
      const keep = Math.min(wav.length, Math.max(0, Math.floor(this.sampleRate * duration[0])));
      const seg = (wav instanceof Float32Array) ? wav.subarray(0, keep) : Float32Array.from(wav).subarray(0, keep);
      segments.push(seg);
      totalLen += seg.length + (i < pieces.length - 1 ? silenceLen : 0);
    }
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (let i = 0; i < segments.length; i++) {
      audio.set(segments[i], off);
      off += segments[i].length + (i < segments.length - 1 ? silenceLen : 0);
    }
    return { audio, rate: this.sampleRate };
  }
}
