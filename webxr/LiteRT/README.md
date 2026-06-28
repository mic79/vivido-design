# LiteRT — On-device Gemma 4 voice assistant for Web & WebXR

A self-contained prototype that runs **Gemma 4** locally in the browser via the
**LiteRT-LM web runtime** (Google's `@mediapipe/tasks-genai`, WebGPU), with a
**100% on-device voice loop** — mic in, GPU processes the tensors locally, voice
comes out — **no cloud, and no Web Speech API**, so it works in the **Meta Quest
browser** as well as Chrome on desktop / laptop / tablet / mobile.

It's built as a small reusable engine + voice layer that drops into other
projects in this repo (`languageVR`, `BattleVR`, …).

```
 getUserMedia (raw PCM)
        │  mono 16 kHz
        ▼
  Whisper  (on-device ASR, Transformers.js · WASM/WebGPU)   ── speech → text
        │
        ▼
  Qwen2.5 0.5B (default) / Gemma 4 E2B  (LiteRT-LM · WebGPU) ── text → text
        │  streamed tokens
        ▼
  Kokoro TTS  (on-device, Transformers.js · WASM/WebGPU)     ── text → audio
        │
        ▼
  Web Audio PannerNode  → 3D spatial voice at an (X,Y,Z) in the WebXR scene
```

> **Why three models?** Gemma 4's **web** `.task` is **text-only** (the vision/
> audio encoders only load on the native Android/iOS/desktop builds — see the
> [model card](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm):
> *"Web on LiteRT-LM uses a specially optimized model for Web … Currently the
> model is text-only"*). And no Gemma variant **emits** audio — they are
> text-output models. So on the web, hearing is done by a small local Whisper and
> speaking by a small local Kokoro. Everything still runs **on-device**.

---

## Files

| File | Purpose |
|------|---------|
| `litert-engine.js` | **Reusable LLM engine.** Wraps MediaPipe `LlmInference`: WebGPU detection, model loading (bundled path / file / URL / buffer, memory-friendly streaming for the ~2 GB model), streaming generation, multi-turn history, the official Gemma 4 prompt template + token cleanup. DOM-free. |
| `voice.js` | **Reusable voice layer.** `MicRecorder` (PCM → mono 16 kHz), `Transcriber` (on-device Whisper STT), `SpatialSpeaker` (on-device Kokoro TTS → Web Audio `PannerNode` for 3D spatial output). No Web Speech API. |
| `models.js` | Model presets + chat templates. **Default = Qwen2.5 0.5B (~547 MB, Apache-2.0, NOT gated → no Hugging Face login / no 401)** because a small LLM leaves enough GPU memory for fast, stable WebGPU voice on Quest 3. Qwen 1.5B (better text) and Gemma 4 E2B (bundled, higher quality) are selectable too — pair the bigger ones with CPU voice. The Gemma 3 1B web preset is GATED, so use it via the Local-file loader. |
| `models/gemma-4-E2B-it-web.task` | The pre-downloaded **Gemma 4 E2B** model (~1.9 GB) so the demos work right away. |
| `index.html` | Responsive flat chat demo (desktop / laptop / tablet / mobile): one-click bundled model, mic push-to-talk, spoken replies. |
| `index-vr.html` | A-Frame **WebXR** demo: in-world panel, laser-clickable prompts, 🎤 talk button, and the AI voice **spatialized from an in-world avatar**. |

---

## Quick start

Served over HTTP (ES modules + fetch need it). From the repo root:

```bash
npx vite
# Flat: http://localhost:5173/LiteRT/index.html
# VR:   http://localhost:5173/LiteRT/index-vr.html
```

1. Press **Load model** → it loads the bundled `./models/gemma-4-E2B-it-web.task`
   (no network). First load compiles the ~2 GB model for WebGPU — give it a bit.
2. Type, or hold **🎤** (flat) / click **🎤 Talk** (VR) to speak.
3. Toggle **🔊 Speak replies** (flat) — in VR the reply is spoken automatically
   and spatialized from the avatar.

First voice use downloads **Whisper** and **Kokoro** once (then cached offline),
loaded lazily so they don't compete with the LLM during startup. Both run in a
**Web Worker**: TTS on **WebGPU** (auto-falls back to WASM), STT on **WASM**.

### Re-downloading / updating the model

```bash
curl.exe -L -C - -o "LiteRT/models/gemma-4-E2B-it-web.task" \
  "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task?download=true"
```

---

## Using it in another project

The engine and the voice layer are independent and DOM-free, so the same calls
work in a flat page or inside an A-Frame/WebXR scene.

```js
import { LiteRTEngine } from '../LiteRT/litert-engine.js';
import { getPreset }   from '../LiteRT/models.js';
import { MicRecorder, Transcriber, SpatialSpeaker } from '../LiteRT/voice.js';

// 1) LLM (text)
const engine = new LiteRTEngine();
await engine.load({ preset: getPreset('gemma4-e2b-web'),
                    modelUrl: '../LiteRT/models/gemma-4-E2B-it-web.task',
                    buffered: false });   // stream the big file (low memory)

// 2) Voice layer (all on-device)
const mic = new MicRecorder();
const asr = new Transcriber({ device: 'wasm' });               // Whisper (CPU)
const tts = new SpatialSpeaker({ device: 'webgpu', spatial: true,
                                 position: { x: 0, y: 1.6, z: -2 } }); // Kokoro + Panner

// LISTEN → THINK → SPEAK (spatial)
await mic.start(); /* user speaks */ const audio = await mic.stop();
const userText = await asr.transcribe(audio);                  // speech → text
const res = await engine.generate(userText, {                 // generate full reply
  system: 'You are a concise VR assistant.',
});
await tts.speak(res.text);                                    // speak the WHOLE reply once
```

### API summary

**`litert-engine.js`**
- `LiteRTEngine.isSupported()` / `.unsupportedReason()` — WebGPU check.
- `engine.load({ preset?, modelFile?, modelUrl?, modelBuffer?, buffered?, onProgress? })`
  — `buffered:false` streams the file via the runtime (use for the ~2 GB model).
- `engine.generate(prompt, { system?, onToken?, includeHistory?, remember? })`
  → `{ text, ttftMs, totalMs, tokensApprox, tokensPerSec }`.
- `engine.reset()` / `engine.dispose()`.
- (`engine.generateFromAudio(...)` is kept for the day a multimodal Gemma **web**
  build ships; it throws on text-only models.)

**`voice.js`**
- `MicRecorder` — `.start()`, `.stop()` → mono 16 kHz `AudioBuffer`, `.dispose()`.
- `Transcriber({ modelId?, device?, dtype?, language? })` — `.load()`,
  `.transcribe(audio)` → text. Default `onnx-community/whisper-base`.
- `SpatialSpeaker({ modelId?, device?, dtype?, voice?, spatial?, position? })` —
  `.speak(text)`, `.stream()` → `{push, flush, cancel}`, `.setPosition(x,y,z)`,
  `.updateListener({px,py,pz,fx,fy,fz,ux,uy,uz})` (lock to the camera),
  `.stop()`, `.listVoices()`. Default `onnx-community/Kokoro-82M-v1.0-ONNX`.

---

## Meta Quest 3 notes

- **LLM size is the GPU-memory budget.** The voice models are separate (Whisper +
  Kokoro), so the LLM never adds STT/TTS *features* — it only competes for GPU
  memory. Gemma 4 E2B (~2 GB on GPU) leaves no room for the fp32 Kokoro TTS
  (~330 MB) → OOM freezes/crashes on Quest. The **default is therefore Qwen2.5
  0.5B (~547 MB, Apache-2.0, non-gated)**, which frees ~1.4 GB so WebGPU voice
  runs **fast *and* stable**. Bigger models (Qwen 1.5B, Gemma 4) stay selectable
  for higher text quality — pair them with CPU voice.
- `getUserMedia`, WebGPU/WASM, and Web Audio `PannerNode` all work in the Quest
  browser. The Web Speech API does **not** — which is exactly why STT/TTS here
  are local models, not `SpeechRecognition`/`speechSynthesis`.
- Performance / scheduling: STT and TTS run in a **Web Worker** (`voice-worker.js`)
  so they never jank the render loop. With the small default LLM, **VR TTS defaults
  to WebGPU `fp32`** (fast) and there's enough GPU headroom to stay stable; a
  session-only **Voice: Stable (CPU) / Fast (GPU)** toggle lets you switch, and a
  crash-guard auto-falls back to CPU for one load if a GPU run ever hard-crashes the
  tab. STT (`whisper-tiny`) runs on WASM. The worker reports the real backend +
  thread count (e.g. `webgpu/fp32` or `wasm/q8 x4`), shown in the demos.
- ⚡ **Cross-origin isolation for fast CPU synth** (`coi-serviceworker.js`, loaded
  first in both pages): WASM is only multi-threaded when the page is
  `crossOriginIsolated` (needs `SharedArrayBuffer`, which needs COOP/COEP headers).
  A plain file server doesn't send those, so this service worker injects them
  (COEP `credentialless`, so the CDN/model fetches still work) — turning slow
  `1-thread` WASM into `x4`+ threads. It reloads the page once on first load. This
  is what makes on-device Whisper/Kokoro fast **without** a GPU and **without**
  server config. Requires a secure context (HTTPS or localhost).
- ⚠ Kokoro on WebGPU: use **`fp32`**. `q8` is garbled (uint8 ops), and `fp16`
  emits **silence/NaN** on GPUs without the `shader-f16` feature (e.g. Meta Quest).
  The worker **probes each backend** (synthesizes a test clip and checks it isn't
  silent) and only keeps one that actually produces sound — otherwise it falls
  back to `wasm/q8`. So `webgpu/fp32` is preferred, CPU is the safety net.
- Whole-reply speech: the demos generate the full text first, then synthesize and
  speak it in **one pass** (no per-sentence loading/gaps) with a
  "Generating speech…" indicator. Keep responses short (a "be brief" system
  prompt) so the single synth stays well under a few seconds.

## Spatial audio (the WebXR win)

`SpatialSpeaker` routes Kokoro's audio through `GainNode → PannerNode →
destination` (HRTF). In `index-vr.html` the panner sits at the avatar's position
and the Web Audio **listener is locked to the camera every frame**, so the AI's
voice convincingly comes from the avatar as you move and turn your head.

---

## Integration notes

### languageVR
`languageVR/index-gemma.html` uses Transformers.js + ONNX Gemma for ASR. This
package gives a cleaner, unified on-device loop: `Transcriber` (Whisper) →
`LiteRTEngine` (Gemma 4 tutor replies) → `SpatialSpeaker` (Kokoro), streamed into
the existing `a-text` panels — multilingual via `new Transcriber({ language:'nl' })`.

### BattleVR
Give each NPC its own `LiteRTEngine` (or one engine with distinct `system`
prompts + histories) for taunts/briefings. Players issue **spoken commands**
(`MicRecorder` + `Transcriber`), and units **talk back** via `SpatialSpeaker`
positioned at each unit so chatter comes from the right place in the arena.

---

## Caveats

- **WebGPU required** for Gemma (GPU-only; no CPU path in the browser).
- **Web Gemma 4 is text-only**; native audio-in / audio-out aren't available in
  the web build, hence the local Whisper + Kokoro. If a multimodal Gemma web
  build ships later, `engine.generateFromAudio()` is ready to use it.
- **First-run downloads:** Whisper + Kokoro fetch their weights once (cached
  afterward). The Gemma model is pre-bundled in `./models`.
- MediaPipe's LLM Inference API is in maintenance mode (Google is focusing on
  LiteRT-LM); the web package remains the supported runtime. Pinned:
  `@mediapipe/tasks-genai@0.10.27`, `@huggingface/transformers@3.7.5`,
  `kokoro-js@1.2.1`.
