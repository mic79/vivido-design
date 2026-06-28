// models.js
// Gemma 4 presets for the LiteRT-LM (MediaPipe GenAI) web runtime.
//
// The browser runtime is @mediapipe/tasks-genai (the official LiteRT-LM web
// path). It is WebGPU-only and runs ".task" bundles converted for the web.
//
// NOTE ON AUDIO (important):
//   Gemma 4's tokenizer has <|image|>/<|audio|> tokens, BUT the *web*-converted
//   .task is **text-only** today (per the litert-community model card: "Web on
//   LiteRT-LM uses a specially optimized model for Web ... Currently the model
//   is text-only"). The vision/audio encoders are only loaded on the native
//   Android/iOS/desktop builds. So on the web we do NOT enable supportAudio for
//   Gemma 4; voice input is handled by a small on-device ASR (Whisper) instead,
//   and voice output by an on-device TTS (Kokoro). See voice.js / README.
//
// PROMPT FORMAT (Gemma 4, official):
//   <|turn>system\n{system}<turn|>\n
//   <|turn>user\n{user}<turn|>\n
//   <|turn>model\n{model}<turn|>\n
//   ...
//   <|turn>model\n            <- generation starts here

/**
 * Gemma 4 chat template. `system`, `history` ({role:'user'|'model', content}),
 * and the current `prompt` are assembled into the official turn format.
 */
function gemma4Template({ system, history, prompt }) {
  let out = '';
  if (system && system.trim()) out += `<|turn>system\n${system.trim()}<turn|>\n`;
  for (const turn of history || []) {
    const role = turn.role === 'assistant' ? 'model' : turn.role;
    out += `<|turn>${role}\n${turn.content}<turn|>\n`;
  }
  out += `<|turn>user\n${prompt}<turn|>\n<|turn>model\n`;
  return out;
}

export const TEMPLATES = {
  gemma4: gemma4Template,
};

/** Raw turn markers (used when interleaving a media chunk with text). */
export const TURN_MARKERS = {
  gemma4: { userOpen: '<|turn>user\n', userClose: '<turn|>\n', modelOpen: '<|turn>model\n' },
};

// Local file downloaded into ./models by setup (works offline / on Quest).
const LOCAL_E2B = './models/gemma-4-E2B-it-web.task';

/**
 * Presets. Gemma 4 only (it is the current generation; older Gemma web models
 * are intentionally dropped). All web builds are text-only — voice is added by
 * voice.js (Whisper in, Kokoro out).
 */
export const MODEL_PRESETS = [
  {
    id: 'gemma4-e2b-web',
    label: 'Gemma 4 E2B (web) — runs on Quest 3, desktop, laptop, tablet, mobile',
    family: 'gemma4',
    template: 'gemma4',
    maxTokens: 2048,
    sizeMB: 2008,
    tier: 'medium',
    audio: false,            // web build is text-only
    local: LOCAL_E2B,        // bundled file → loads with no network
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task?download=true',
    note: 'Default. ~2 GB. Pre-downloaded to ./models so it works right away.',
  },
  {
    id: 'gemma4-e4b-web',
    label: 'Gemma 4 E4B (web) — higher quality, strong desktop GPU',
    family: 'gemma4',
    template: 'gemma4',
    maxTokens: 2048,
    sizeMB: 2827,
    tier: 'heavy',
    audio: false,
    local: null,
    url: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.task?download=true',
    note: 'Bigger/better. ~3 GB — desktop class GPU; heavy for Quest/mobile.',
  },
];

export function getPreset(id) {
  return MODEL_PRESETS.find((p) => p.id === id) || null;
}
