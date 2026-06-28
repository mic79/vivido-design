// voice-worker.js
// Runs on-device speech-to-text (Whisper) and text-to-speech (Kokoro) OFF the
// main thread. This is critical on Meta Quest: doing this compute on the UI
// thread froze the render loop, and doing it on WebGPU fought the ~2 GB LLM for
// GPU memory and crashed the tab. Here it runs on WASM/CPU in a Worker, so the
// headset keeps rendering smoothly and the GPU stays reserved for the LLM.
//
// Protocol (postMessage):
//   in : { id, type:'warm-asr'|'warm-tts', payload:{ cfg } }
//        { id, type:'asr', payload:{ cfg, audio:Float32Array, language } }
//        { id, type:'tts', payload:{ cfg, text, voice } }
//   out: { id, type:'ok' }
//        { id, type:'asr-result', payload:{ text } }
//        { id, type:'tts-result', payload:{ audio:Float32Array, rate } }
//        { id, type:'error', payload:{ message } }

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';
const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

let _tf = null, _kokoro = null, asr = null, tts = null;
async function tf() { if (!_tf) _tf = await import(TRANSFORMERS_URL); return _tf; }
async function kk() { if (!_kokoro) _kokoro = await import(KOKORO_URL); return _kokoro; }

async function ensureAsr(cfg) {
  if (asr) return asr;
  const { pipeline } = await tf();
  asr = await pipeline('automatic-speech-recognition', cfg.modelId, {
    device: cfg.device, dtype: cfg.dtype,
  });
  return asr;
}

async function ensureTts(cfg) {
  if (tts) return tts;
  const { KokoroTTS } = await kk();
  tts = await KokoroTTS.from_pretrained(cfg.modelId, {
    device: cfg.device, dtype: cfg.dtype,
  });
  return tts;
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
      reply(id, 'ok');
    } else if (type === 'warm-tts') {
      await ensureTts(payload.cfg);
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
      await ensureTts(payload.cfg);
      const audio = await tts.generate(payload.text, { voice: payload.voice });
      const src = audio.audio || audio.data;
      const rate = audio.sampling_rate || audio.sampleRate || 24000;
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
