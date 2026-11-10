# MotionGuidanceVR5 — objective orientation research tool

Realtime WebXR instrument for studying how headset orientation tracks a **path-derived ideal** during **predefined** locomotion. No steering, no symptom questionnaires, no offline stereo renders.

Environments are generated per room (`src/architecture.js`) — no external models. Each room is built around its own course, so the walls follow the route.

## Run

```bash
node serve.mjs 9500
# http://127.0.0.1:9500/
```

Chrome + Meta Link for immersive VR. Desktop “Play on screen” uses the same capture pipeline (drag to look).

**Hall style** (home top bar, or `?style=classic` / `?style=mughal` / `?style=future`):  
- **Classic** — colonnades, arches, coffered vaults / dome (default).  
- **Mughal** — the same rooms as an Agra-style court: red sandstone walls, white marble dado and floor, cusped (multifoil) arches, hexagonal jali screens throwing patterned sun, bracket-capital octagonal piers, a star-inlaid shallow vault, and an onion dome over the rotundas.  
- **Future** — seamless Subside-like soft rooms: filleted shell, panel grooves, ceiling ring lights, no columns. Preference is saved in `localStorage`.

## Calibration modules (design references)

Presentation borrows from:

1. **Portal / The Lab** — numbered chamber, title, timed trial, obvious completion.
2. **Lone Echo calibration** — single-purpose modules, holographic panel, step checklist, one mechanic per module, minimal, architectural dressing built into the room itself. Each MGVR5 module notes its Lone Echo parallel in `echoRef` (in `src/tests.js`).

Each run: fade in → **voice briefing** + one upright glass card (front-left, yaw/pitch only, chapter + "room n of 14" progress, animated plan or side profile of the route) over calm music → **Begin** (trigger / Space / click on the button) → card fades away → ride → completion card with friendly feedback (**stay in VR**): **Next**, **Repeat**, **All rooms**. The All-rooms grid jumps to any room; completed rooms are ticked. Progress is kept in `localStorage` (`mg5.progress.v2`) and the start screen continues where you left off. Laser pointers on both controllers (or the mouse) press card buttons. Default XR controller models are shown; no head-locked HUD.

### Rooms — four chapters, increasing difficulty

Halls are built procedurally per course. **Classic** (`src/architecture.js`) is a nave (coffered barrel vault, fluted colonnades, arched windows) or a rotunda (column ring, coffered dome with oculus). **Mughal** (`src/architectureMughal.js`) keeps that plan and swaps in cusped arches, a sandstone chhajja, hex jali windows, octagonal bracket piers, a shallow star-inlaid vault, and an onion dome. The exit is an open portal into a lit vestibule tinted with the next room's colour. Elevated courses run on a floating deck with glass balustrade.

| Id | Room | Hall | Course | Protocol |
|---|---|---|---|---|
| `C01_still` | Still Stance | rotunda | 12 s still | standing |
| `C02_glide` | First Glide | nave | 18 m straight, 1.0 m/s | standing |
| `C03_brisk` | Brisk Glide | nave | 36 m straight, 2.4 m/s | standing |
| `C04_curveL` | Wide Curve Left | nave | 45° left, R 22 m | seated |
| `C05_curveR` | Wide Curve Right | nave | 45° right, R 22 m | seated |
| `C06_sbend` | S-Bend | nave | 40° / 40°, R 16 m | seated |
| `C07_tight` | Tight Turn | rotunda | 90° left, R 8 m | seated |
| `C08_sharp` | Sharp Turn | rotunda | 90° right, R 5 m | seated |
| `C09_rise` | Gentle Ascent | nave | 8 % climb | standing |
| `C10_descent` | Descent | nave | 12 % descent | standing |
| `C11_climb` | Steep Climb | nave | 24 % climb | standing |
| `C12_spiral` | Spiral Ascent | rotunda + light axis | 200° left, R 7 m, 12 % climb | seated |
| `C13_look` | Look Targets | nave | 2 holo targets (left / right) | standing |
| `C14_lookud` | Look Up & Down | nave | 3 targets (high / low) | standing |

Gaze targets: fill ring (≈1.8 s inside a 7° cone, drains if you look away) + live gaze dot.

| Protocol | Ideal | Error meaning |
|---|---|---|
| **seated** | Roll leans into turns | Driver-like alignment |
| **standing** | Upright vs gravity | Lean / sway |

### Rendering

Sun (DirectionalLight, 2048 PCF soft shadow map, rendered once per room and re-projected as the lab moves), PMREM environment captured from the hall itself, exponential fog, ACES tone mapping, additive god-ray beams from windows and oculus. The floor is a **glossy planar reflector** (`src/reflector.js`, after whiteRoomVR's GlossyReflector): mirror capture + height-from-floor map + separable blur, mixed into the lit floor by fresnel — sharp near contact, soft for tall architecture; captured once per frame for both eyes. Textures (`src/textures.js`) are procedural canvas maps: polished stone tiles, ashlar walls, stepped coffers with light points. `?lite` disables shadows and the reflector.

Sound (`sfx.js`, WebAudio): room tone with reverb sized to the space, airflow that follows speed, rising gaze tone, chimes. Haptics: ready, gaze quarter-ticks, target done, completion.

Comfort rules (`src/path.js`, `src/main.js`):
- Courses are open paths built from straights, clothoid-eased turns and eased grade changes. No loops; walls follow the route.
- Speed follows a cosine ramp in and out (continuous velocity and acceleration, zero at both ends). The room transform is applied exactly — nothing ever slides to “catch up”.
- Moving to another room (next / repeat / menu jump / first entry) always happens under a full fade to black; the participant is never visibly repositioned.
- Grip is a silent brake (slows the ride) — not a test.

Verify headless (server on :9500):
- `node verify-mg5.mjs` — all 14 rooms end-to-end plus a menu jump: invisible repositioning, card upright/facing/hidden in rides, yaw continuity, gaze-bot fills every target, feedback, progress saved, screenshots → `verify-out/walk/` (`ONLY=` subset, `SWIFT=1` software GL).
- `GPU=1 node probe-rooms.mjs` — screenshots + draw/tri counts per room and pose (`IDS`, `POS`, `YAWS`, `PITCH`).

Audio lives project-local under `assets/audio/` (`calm-bgm.mp3` + `voice/*.mp3`). Regenerate VO with `node scripts/gen-voice.mjs` (needs `edge-tts`). Start-screen toggles: Music / Voice.

## Storage & export

Finished sessions are stored in **IndexedDB** in this browser (session index in `localStorage`). Nothing auto-downloads.

- **Export selected** / row **Export** → `.jsonl` + `-summary.json`
- **Export all** → bundled `.json` + `.jsonl`
- **Clear all** wipes the local archive

Clearing site data for this origin deletes the archive.

## Signal dictionary (`session-*.jsonl`)

One JSON object per line. Types: `meta`, `event`, `sample`.

### `meta`
`participantId`, `protocol`, `speedMps`, `baselineSec`, `rideSec`, `startedAt`, `endedAt`

### `event`
`t`, `type` (`start` | `ride_start` | `calm_start` | `calm_end` | `end`), optional fields

### `sample` (≈ display Hz)

| Field | Unit | Meaning |
|---|---|---|
| `t` | s | Session time |
| `phase` | 0/1 | Baseline / ride |
| `s` | m | Path arc length |
| `speed` | m/s | Instantaneous path speed (after calm scale) |
| `curvature` | 1/m | Signed path curvature (left +) |
| `pathYaw` | rad | Path heading |
| `pathX`,`pathZ` | m | Path position |
| `hx,hy,hz` | m | Head world position |
| `yaw,pitch,roll` | rad | Head euler YXZ |
| `idealYaw,idealPitch,idealRoll` | rad | Protocol ideal |
| `errYaw,errPitch,errRoll` | rad | Wrapped actual − ideal |
| `angVel*` / `angAcc*` | rad/s, rad/s² | Finite-difference head rates |
| `swayRms` | m | RMS head XZ vs path over ~2 s |
| `swayPath` | m | Path length of that sway window |
| `calm` | 0..1 | Calm blend |

`summary.json` adds mean/peak |err|, turn vs straight |errRoll|, adaptation slope (late − early third; **negative ⇒ closer to ideal**), baseline sway.

## Literature pointers (instrument motivation)

- Trunk / postural alignment with virtual trajectory and cybersickness risk — e.g. “Just Roll with It” (anticipatory lean).
- Differences in virtual vs physical head pose (DVP) under HMD lag — Palmisano et al., *Frontiers in Virtual Reality* (2020).
- Quiet-stance postural instability as a predictor of cybersickness — Stoffregen / Arcioni line of work.
- Rest frames and gravitational upright — mixed evidence; V5 logs orientation so alignment hypotheses can be tested later.

This app **does not** claim clinical efficacy; it exports kinematics for analysis.

## Project layout

```
MotionGuidanceVR5/
  index.html
  serve.mjs
  README.md
  assets/audio/ (calm-bgm.mp3, voice/*.mp3)
  lib/three.module.js
  lib/addons/...
  src/main.js        flow, inverse locomotion, gaze, feedback
  src/architecture.js  procedural halls (nave / rotunda), sun, shadows, PMREM
  src/reflector.js   glossy planar floor reflection
  src/textures.js    procedural stone / wall / coffer maps
  src/chamberEnv.js  fixtures (floor line, rings, gaze targets) + guide card + room menu
  src/tests.js       chapters + room definitions (copy, route, hall spec)
  src/sfx.js audio.js path.js capture.js store.js viz.js
```

## Notes

- Leave MotionGuidanceVR4 untouched (pre-rendered aesthetic experiment).
- Assets are project-local (no `../` runtime URLs). XR controller meshes come from the WebXR input-profiles CDN (three's default).
- No FMS/SSQ in v1 by design (objective-only).
