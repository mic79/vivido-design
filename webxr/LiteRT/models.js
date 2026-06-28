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

// Local files in ./models (work offline / on Quest, no network at runtime).
const LOCAL_E2B = './models/gemma-4-E2B-it-web.task';
const LOCAL_GEMMA3_1B = './models/gemma3-1b-it-int4-web.task';

/**
 * Presets. All web builds are TEXT-ONLY — voice is added by voice.js (Whisper
 * in, Kokoro out), so the choice of LLM does NOT change voice capability.
 *
 * IMPORTANT — web compatibility: the browser runtime can only run Google's
 * specially **web-optimized** ".task" bundles (file names ending in "-web").
 * Standard Android ".task" files (e.g. Qwen2.5 from litert-community) do NOT
 * run on the WebGPU delegate — they abort with "BROADCAST_TO not supported",
 * "RESHAPE bad input dims size: 5", "Tensor type(INT64) not supported", etc.
 * So only Gemma "-web" builds are usable here.
 *
 * Default = Gemma 4 E2B (bundled local file → works offline, no Hugging Face
 * login). It's large (~2 GB on GPU), so pair it with the "Stable (CPU)" voice
 * mode on Quest. For fast GPU voice, use the small Gemma 3 1B (web) preset:
 * it's gated on Hugging Face, so download it ONCE and drop it in ./models (see
 * its note) — then it loads locally with no 401.
 */
export const MODEL_PRESETS = [
  {
    id: 'gemma3-270m-web',
    label: 'Gemma 3 270M (web) — tiny + fast GPU voice',
    family: 'gemma3',
    template: 'gemma3',
    maxTokens: 1280,
    sizeMB: 249,
    tier: 'light',
    audio: false,            // web build is text-only (voice = Whisper + Kokoro)
    // Served from public Cloudflare R2 (the HF repo is gated → 401 from the
    // browser, and the ~250 MB LFS file can't be committed to git). Downloaded
    // once into the OPFS on-disk cache (resumable), then loads offline on reload.
    // NOTE: the R2 bucket MUST have a CORS policy (Access-Control-Allow-Origin)
    // or the browser blocks this cross-origin fetch. See README.
    local: null,
    url: 'https://pub-65c21cd4f13345fcb1574dc28def6a19.r2.dev/gemma3-270m-it-q4_0-web.task',
    note: 'Smallest LLM (~249 MB, q4_0 web build) → leaves the most GPU room, so WebGPU voice runs fast + stable on Quest 3. Streamed from Cloudflare R2 and cached on-device after the first load. (Source: gated litert-community/gemma-3-270m-it on Hugging Face; q8-web is a higher-quality ~276 MB alternative.)',
  },
  {
    id: 'gemma4-e2b-web',
    label: 'Gemma 4 E2B (web) — bundled, works offline (Quest: use CPU voice)',
    family: 'gemma4',
    template: 'gemma4',
    maxTokens: 2048,
    sizeMB: 2008,
    tier: 'medium',
    audio: false,            // web build is text-only
    local: LOCAL_E2B,        // bundled file → loads with no network
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task?download=true',
    note: 'Default. ~2 GB, pre-downloaded to ./models (no login). On Quest 3 it fills the GPU, so use the “Stable (CPU)” voice mode (GPU voice may OOM).',
  },
  {
    id: 'gemma3-1b-web',
    label: 'Gemma 3 1B (web) — small + fast GPU voice (one-time local download)',
    family: 'gemma3',
    template: 'gemma3',
    maxTokens: 1280,         // matches the web build's 1280 KV cache
    sizeMB: 555,
    tier: 'light',
    audio: false,            // web build is text-only (voice = Whisper + Kokoro)
    local: LOCAL_GEMMA3_1B,  // loaded locally once you place the file here
    url: 'https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4-web.task?download=true',
    note: 'Small LLM → leaves GPU room so WebGPU voice is fast + stable. The HF repo is GATED (URL gives HTTP 401), so: accept the Gemma license on Hugging Face, download gemma3-1b-it-int4-web.task once, and place it in ./models/ — it then loads locally with no login.',
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
