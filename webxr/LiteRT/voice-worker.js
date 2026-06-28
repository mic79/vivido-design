// voice-worker.js
// Runs on-device speech-to-text (Whisper) and text-to-speech (Kokoro OR
// Supertonic) OFF the main thread. This is critical on Meta Quest: doing this
// compute on the UI thread froze the render loop, and doing it on WebGPU fought
// the LLM for GPU memory and crashed the tab. Here it runs on WASM/CPU in a
// Worker, so the headset keeps rendering smoothly and the GPU stays reserved for
// the LLM.
//
// TTS engines (cfg.engine):
//   'kokoro'     — Kokoro-82M (kokoro-js). Fast on WebGPU, slow on CPU.
//   'supertonic' — Supertonic 2 (transformers.js text-to-speech pipeline). Tuned
//                  for CPU: fast on WASM AND no GPU contention → smooth on Quest.
//                  Quality/speed dial = num_inference_steps (cfg.steps, ~5 fast).
//
// Protocol (postMessage):
//   in : { id, type:'warm-asr'|'warm-tts', payload:{ cfg } }
//        { id, type:'asr', payload:{ cfg, audio:Float32Array, language } }
//        { id, type:'tts', payload:{ cfg, text, voice } }
//   out: { id, type:'ok' }
//        { id, type:'asr-result', payload:{ text } }
//        { id, type:'tts-result', payload:{ audio:Float32Array, rate } }
//        { id, type:'error', payload:{ message } }

// 4.x is required for the Supertonic text-to-speech pipeline (added in v4); the
// Whisper ASR pipeline API is unchanged from 3.x, so STT keeps working.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

let _tf = null, _kokoro = null, asr = null, tts = null;
let ttsBackend = '', asrBackend = ''; // which device/dtype actually loaded (diagnostics)
let ttsEngine = '';                   // 'kokoro' | 'supertonic' currently loaded
const _spkCache = new Map();          // Supertonic speaker-embedding cache (per voice)
const isSupertonic = (cfg) => !!(cfg && cfg.engine === 'supertonic');
async function tf() {
  if (!_tf) {
    _tf = await import(TRANSFORMERS_URL);
    // Use multiple CPU cores for the WASM backend when the page allows it
    // (requires cross-origin isolation for SharedArrayBuffer; otherwise it stays
    // single-thread). Leave ~2 cores for the render/main thread so the headset
    // stays smooth while synthesizing.
    try {
      const hc = (self.navigator && navigator.hardwareConcurrency) || 4;
      _tf.env.backends.onnx.wasm.numThreads = Math.max(2, Math.min(8, hc - 1));
    } catch (_) {}
  }
  return _tf;
}
async function kk() { if (!_kokoro) _kokoro = await import(KOKORO_URL); return _kokoro; }

// Try each {device,dtype} in order until one loads. We report which one won so
// the UI/console can show the real backend (no more guessing why it's slow).
async function loadFirst(label, candidates, make) {
  let lastErr;
  for (const c of candidates) {
    try {
      const inst = await make(c);
      const backend = `${c.device}/${c.dtype}`;
      console.log(`[voice-worker] ${label} loaded on ${backend}`);
      return { inst, backend };
    } catch (e) {
      lastErr = e;
      console.warn(`[voice-worker] ${label} on ${c.device}/${c.dtype} failed: ${e && e.message}`);
    }
  }
  throw lastErr || new Error(`${label}: no backend available`);
}

async function ensureAsr(cfg) {
  if (asr) return asr;
  const { pipeline } = await tf();
  const r = await loadFirst('ASR', [
    { device: cfg.device, dtype: cfg.dtype },
    { device: 'wasm', dtype: 'fp32' },
  ], (c) => pipeline('automatic-speech-recognition', cfg.modelId, { device: c.device, dtype: c.dtype }));
  asr = r.inst; asrBackend = r.backend;
  return asr;
}

// Some GPU/dtype combos LOAD fine but emit silence or NaN — most notably fp16 on
// GPUs without the WebGPU `shader-f16` feature (e.g. Meta Quest), and uint8 (q8)
// on WebGPU. So we don't trust a backend until it has actually produced audible
// samples from a tiny probe synth. This is what stops the device guessing-game.
async function producesAudio(inst, voice) {
  try {
    const out = await inst.generate('Test.', { voice: voice || 'af_heart' });
    const data = out.audio || out.data;
    if (!data || !data.length) return false;
    let max = 0;
    const step = Math.max(1, (data.length / 4000) | 0);
    for (let i = 0; i < data.length; i += step) {
      const v = data[i];
      if (Number.isNaN(v)) return false;
      const a = Math.abs(v);
      if (a > max) max = a;
    }
    return max > 1e-4; // non-silent
  } catch (_) { return false; }
}

// Dispatch to the requested TTS engine. Reuses a loaded instance only when the
// engine matches; switching engines goes through 'reset-tts' first.
async function ensureTts(cfg) {
  if (tts && ttsEngine === (cfg.engine || 'kokoro')) return tts;
  if (isSupertonic(cfg)) return ensureSupertonic(cfg);
  return ensureKokoro(cfg);
}

// Load (and cache) a Supertonic speaker embedding (.bin = raw float32) so we
// don't refetch it on every sentence.
async function supertonicEmbedding(modelId, voice) {
  const key = `${modelId}/${voice}`;
  if (_spkCache.has(key)) return _spkCache.get(key);
  const url = `https://huggingface.co/${modelId}/resolve/main/voices/${voice}.bin`;
  const buf = await (await fetch(url)).arrayBuffer();
  const emb = new Float32Array(buf);
  _spkCache.set(key, emb);
  return emb;
}

async function ensureSupertonic(cfg) {
  if (tts && ttsEngine === 'supertonic') return tts;
  const { pipeline } = await tf();
  // Supertonic ships fp32 only and is tuned for CPU (upstream marks GPU mode
  // "not tested"), so we run it on WASM/CPU — its strength — which also keeps the
  // GPU free for the LLM and the WebXR compositor (no stutter).
  const r = await loadFirst('Supertonic', [
    { device: 'wasm', dtype: 'fp32' },
  ], (c) => pipeline('text-to-speech', cfg.modelId, { device: c.device, dtype: c.dtype }));
  tts = r.inst; ttsEngine = 'supertonic';
  const threads = self.crossOriginIsolated ? `x${_tf.env.backends.onnx.wasm.numThreads}` : '1-thread';
  ttsBackend = `supertonic ${r.backend} ${threads}`;
  console.log(`[voice-worker] TTS using ${ttsBackend}`);
  return tts;
}

async function ensureKokoro(cfg) {
  if (tts && ttsEngine === 'kokoro') return tts;
  await tf(); // configure WASM threading for the CPU path
  const { KokoroTTS } = await kk();
  // GPU: prefer fp32 (works without shader-f16, unlike fp16; q8 is broken on GPU).
  // CPU: q8 (correct + small). Each candidate must PASS the audio probe to be used.
  const wantGpu = cfg.device && cfg.device !== 'wasm';
  const candidates = wantGpu
    ? [{ device: cfg.device, dtype: 'fp32' }, { device: cfg.device, dtype: 'fp16' }, { device: 'wasm', dtype: 'q8' }]
    : [{ device: 'wasm', dtype: cfg.dtype || 'q8' }];

  let lastErr;
  for (const c of candidates) {
    try {
      const inst = await KokoroTTS.from_pretrained(cfg.modelId, { device: c.device, dtype: c.dtype });
      // Probe only GPU backends (where silent/NaN happens). WASM/CPU is known-good,
      // so skip the extra test synth to keep first-use latency down.
      if (c.device !== 'wasm' && !(await producesAudio(inst, cfg.voice))) {
        console.warn(`[voice-worker] TTS ${c.device}/${c.dtype} loaded but produced silent/NaN audio — trying next backend`);
        continue;
      }
      tts = inst; ttsEngine = 'kokoro';
      const threads = /wasm/i.test(c.device)
        ? (self.crossOriginIsolated ? `x${_tf.env.backends.onnx.wasm.numThreads}` : '1-thread')
        : '';
      ttsBackend = `${c.device}/${c.dtype}${threads ? ' ' + threads : ''}`;
      console.log(`[voice-worker] TTS using ${ttsBackend}`);
      return tts;
    } catch (e) {
      lastErr = e;
      console.warn(`[voice-worker] TTS ${c.device}/${c.dtype} failed to load: ${e && e.message}`);
    }
  }
  throw lastErr || new Error('TTS: no working backend (all produced silence or failed)');
}

// Process messages strictly one-at-a-time. The worker has a single CPU budget,
// and streaming TTS fires several synth requests in quick succession; running
// them sequentially avoids contention and keeps output in order.
let _chain = Promise.resolve();
self.onmessage = (e) => { _chain = _chain.then(() => handle(e.data || {})); };

async function handle(msg) {
  const { id, type, payload } = msg;
  try {
    if (type === 'warm-asr') {
      await ensureAsr(payload.cfg);
      reply(id, 'ok', { backend: asrBackend });
    } else if (type === 'warm-tts') {
      await ensureTts(payload.cfg);
      reply(id, 'ok', { backend: ttsBackend });
    } else if (type === 'reset-tts') {
      // Drop the cached model so the next warm/synth reloads on a new device or
      // engine (used by the voice toggle). Frees the previous backend's memory.
      tts = null; ttsBackend = ''; ttsEngine = '';
      reply(id, 'ok');
    } else if (type === 'asr') {
      await ensureAsr(payload.cfg);
      const out = await asr(payload.audio, {
        task: 'transcribe',
        language: payload.language || undefined,
        chunk_length_s: 30,
        return_timestamps: false,
        no_repeat_ngram_size: 3,
        temperature: 0,
      });
      reply(id, 'asr-result', { text: ((out && out.text) || '').trim() });
    } else if (type === 'tts') {
      const cfg = payload.cfg || {};
      await ensureTts(cfg);
      let src, rate;
      if (isSupertonic(cfg)) {
        const voice = payload.voice || cfg.voice || 'F1';
        const emb = await supertonicEmbedding(cfg.modelId, voice);
        const out = await tts(payload.text, {
          speaker_embeddings: emb,
          num_inference_steps: cfg.steps || 5, // the "5-step" speed/quality dial
          speed: cfg.speed || 1.0,
        });
        src = out.audio || out.data;
        rate = out.sampling_rate || out.sampleRate || 44100;
      } else {
        const audio = await tts.generate(payload.text, { voice: payload.voice });
        src = audio.audio || audio.data;
        rate = audio.sampling_rate || audio.sampleRate || 24000;
      }
      const copy = new Float32Array(src); // standalone, transferable buffer
      reply(id, 'tts-result', { audio: copy, rate }, [copy.buffer]);
    } else {
      reply(id, 'error', { message: `Unknown message type: ${type}` });
    }
  } catch (err) {
    reply(id, 'error', { message: (err && err.message) || String(err) });
  }
}

function reply(id, type, payload = {}, transfer) {
  self.postMessage({ id, type, payload }, transfer || []);
}
