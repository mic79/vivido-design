# DriveVR2

Self-contained WebXR driving game (`index.html` + local assets). Serve this folder with any static HTTP server (required for GLTF, audio, and ES modules).

```bash
# Example (from DriveVR2/)
npx --yes serve .
# Open http://localhost:3000/
```

## Select Track (menu)

Open the menu (**B** in VR / same as multiplayer menu on desktop) and choose **SELECT TRACK** (VR: **TRACKS**).

| Tab | Contents |
|-----|----------|
| **PRESETS** | Built-in tracks (Default Circuit, Quick Oval, Flat Square, Hill Climb, Figure Eight). Each is a stored `?track=` string — no extra files. |
| **MY TRACKS** | **5** personal slots in `localStorage`. **SAVE AS** / **OVERWRITE** stores only the compact `?track=` param for the current layout (from the live track or track editor). **LOAD** applies it and updates the browser URL. **DEL** clears a slot. |

Preset and slot definitions live in `track-presets.js` (`TrackManager`). VR uses the same lists on a 3D panel; desktop uses the HTML overlay.

**Multiplayer:** Only the **host** can open the track selector or load a track. When the host loads a preset or personal slot, a `track-load` message (compact `trackParam` + name) is sent to every client in the lobby; new joiners receive the host’s current track on connect (same idea as BattleVR arena sync).

## Custom track (`?track=`)

Compact format: pipe-separated control points in **world meters**.

```
?track=x,y,z|x,y,z,bank|...
```

- Minimum **4** points, maximum **120**
- Optional **bank** per point: **-60** to **+60** (degrees). Omitted = `0`
- **Sign:** positive tilts the **left** edge up (right edge down); negative tilts the opposite
- Closed loop: Catmull–Rom spline; first point need not repeat last

Example (4-point flat oval):

```
index.html?track=-40,0,60|-40,0,-60|40,0,-60|40,0,60
```

## Bot navigation

The bot follows `denseWaypoints` built from the same `racingPath` as the road. Any valid `?track=` layout is used automatically for bot AI, checkpoints, and spawn elevation.

## Track editor

Press **T** to toggle editor (desktop or VR). Use **fly camera** (**C**) to scout spots in the city, then place the track with layout mode.

| Key / control | Action |
|---------------|--------|
| **T** | Toggle editor on/off |
| **G** / VR left **Y** | Toggle **layout mode** (move **entire track** vs single point) |
| **← → ↑ ↓** | Point mode: move one control point 1 m (camera-relative) |
| **G + layout** | Move **all** control points 25 m (camera-relative on XZ) |
| **Ctrl** (layout) | 100 m steps (4× faster repositioning in the city) |
| **Shift+↑ ↓** | Point: Y ±1 m · Layout: Y ±10 m for whole track |
| **Shift+← →** | Bank ±5° (point mode only) |
| **PgUp / PgDn** | Next / previous edit point (you stand at the previous point) |
| VR left **X** | Toggle editor |
| VR sticks (no modifier) | Fly only while in fly camera |
| VR **grip or trigger** (per hand) | Track-edit modifier (like Shift/Ctrl); that hand’s stick/trig/grip edit instead of fly |
| VR **R** mod + stick | Point or layout move (head-relative) |
| VR **R** mod + trig / grip | Point or layout height |
| VR **L** mod + stick | Point: bank (X) / next·prev point (Y) · Layout: move all on XZ |
| VR **L** mod + trig / grip | Layout: whole-track height only |

Layout mode keeps track shape intact (only translates every control point). Height is still limited to the editor Y range. Save to a personal slot or copy `?track=…` when done.

Copy the `?track=…` string from the HUD or run `DriveVR2.getEditorTrack()` in the console.

## City environment

- **Default:** VRrunner giant city (`VRrunner/3d/scene.gltf` + `scene.bin`, 100× scale, mesh BVH building collision).
- **Legacy blocks:** `?city=procedural`

## VR motion controllers

In headset, Quest-style **controller shells** and **floating button labels** (same VRrunner / VRKnockout pattern: pulsing ring + text beside each hint) show on your grips for the current mode (drive, menu, track editor).

- Grips are parented to the **scene** (not the car camera rig), so WebXR tracking stays aligned with your real hands.
- A bright blue **fallback shell** is always added; optional Quest GLTF loads on top.
- Labels refresh when you open the menu, track editor, or layout mode.
- Add **`?simplexrctrl=1`** if GLTF controller models fail to load (hints still work; fallback mesh only).

## Fly camera

- **C** / VR **A** — toggle fly / driving camera
- **Shift** (hold) / VR **hold left Y** (fly) or **hold left stick click** (track editor + fly) — **10× faster** movement
- **J** — spawn car at fly camera (fly mode only)
- No position limits in fly mode

## Physics debug wireframes

- Press **P** to toggle, or add **`?debugPhysics=1`** to show on load
- **Cyan** — active road collision (top surface)
- **Red** — triangles removed at over/under crossings (wrong deck)
- **Magenta** — full visual road mesh (includes sides/thickness)
- **Orange** — city physics boxes · **Gray** — fallback ground (y = -1)

## Bundled assets (referenced by `index.html` only)

| Path | Used for |
|------|----------|
| `assets/sportcar017/` | Player / bot / remote vehicle GLTF + textures |
| `assets/mountains-cubemap/` | Skybox (`?city=procedural` & WebXR cube layer) |
| `audio/machina-tobias-voigt-main-version-19314-02-39.mp3` | Background music |
| `audio/sound-design-elements-impact-sfx-ps-084-353199.mp3` | Vehicle/building collision SFX (spatialized) |
| `track-presets.js` | Preset track list + personal slot storage API |

Engine and tire screech are procedural Web Audio; collision uses the impact sample above.
| `VRrunner/3d/scene.gltf` + `scene.bin` | Default city mesh |
| `VRrunner/textures/overcast_soil_puresky_1k.exr` | Image-based lighting (VRrunner look) |
| `js/radialFogMaterials.js` | Radial fog shaders |

Procedural city (`?city=procedural`) uses **canvas-generated** textures only — no ground GLTF or tree sprite files.

Runtime still loads **Three.js 0.169**, **Ammo.js**, **PeerJS**, and **three-mesh-bvh** from CDNs.

## Dev helpers (browser console)

```javascript
DriveVR2.getDefaultTrackParam()  // encode built-in track for sharing
DriveVR2.getTrackInfo()          // source, point counts, bank array
```
