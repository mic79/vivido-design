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

/**
 * Gemma 3 chat template (the classic Gemma format). Gemma 3 has no dedicated
 * system role, so the system instruction is folded into the FIRST user turn.
 *   <start_of_turn>user\n{system?}\n\n{user}<end_of_turn>\n
 *   <start_of_turn>model\n{model}<end_of_turn>\n
 *   ...
 *   <start_of_turn>model\n   <- generation starts here
 */
function gemma3Template({ system, history, prompt }) {
  const sys = system && system.trim() ? system.trim() : '';
  let out = '';
  let foldedSystem = false;
  const fold = (userText) => {
    if (sys && !foldedSystem) { foldedSystem = true; return `${sys}\n\n${userText}`; }
    return userText;
  };
  for (const turn of history || []) {
    const role = turn.role === 'assistant' ? 'model' : turn.role;
    if (role === 'user') out += `<start_of_turn>user\n${fold(turn.content)}<end_of_turn>\n`;
    else out += `<start_of_turn>model\n${turn.content}<end_of_turn>\n`;
  }
  out += `<start_of_turn>user\n${fold(prompt)}<end_of_turn>\n<start_of_turn>model\n`;
  return out;
}

export const TEMPLATES = {
  gemma4: gemma4Template,
  gemma3: gemma3Template,
};

/** Raw turn markers (used when interleaving a media chunk with text). */
export const TURN_MARKERS = {
  gemma4: { userOpen: '<|turn>user\n', userClose: '<turn|>\n', modelOpen: '<|turn>model\n' },
  gemma3: { userOpen: '<start_of_turn>user\n', userClose: '<end_of_turn>\n', modelOpen: '<start_of_turn>model\n' },
};

// Local file downloaded into ./models by setup (works offline / on Quest).
const LOCAL_E2B = './models/gemma-4-E2B-it-web.task';

/**
 * Presets. All web builds are TEXT-ONLY — voice is added by voice.js (Whisper
 * in, Kokoro out), so the choice of LLM does NOT change voice capability.
 *
 * The default is Gemma 3 1B: at ~555 MB it leaves ~1.4 GB of GPU memory free
 * (vs ~2 GB for Gemma 4 E2B), which is what lets the WebGPU TTS (Kokoro fp32)
 * run fast AND stable on Quest 3 instead of OOM-crashing. Gemma 4 stays
 * selectable below for higher text quality (use the CPU voice path with it).
 */
export const MODEL_PRESETS = [
  {
    id: 'gemma3-1b-web',
    label: 'Gemma 3 1B (web) — small + fast, frees GPU for voice (best on Quest 3)',
    family: 'gemma3',
    template: 'gemma3',
    maxTokens: 1280,         // matches the web build's 1280 KV cache
    sizeMB: 555,
    tier: 'light',
    audio: false,            // web build is text-only (voice = Whisper + Kokoro)
    local: null,             // not bundled; loads from URL (cached to OPFS)
    url: 'https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4-web.task?download=true',
    note: 'Default. ~555 MB. Small LLM → leaves GPU room so WebGPU voice (Kokoro fp32) is fast + stable. If the link is gated, accept the Gemma license on Hugging Face once, or download the .task and use the “Local file” loader.',
  },
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
    note: 'Higher text quality. ~2 GB. Pre-downloaded to ./models. Note: on Quest 3 this leaves little GPU memory, so use the “Stable (CPU)” voice mode with it (GPU voice may OOM).',
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
