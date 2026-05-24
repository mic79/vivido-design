# DriveVR2

Self-contained WebXR driving game (`index.html` + local assets). Serve this folder with any static HTTP server (required for GLTF, audio, and ES modules).

```bash
# Example (from DriveVR2/)
npx --yes serve .
# Open http://localhost:3000/
```

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

## Track editor (desktop)

Press **T** while driving to toggle editor mode (not in VR).

| Key | Action |
|-----|--------|
| **T** | Toggle editor on/off |
| **← →** | Strafe point ±1 m (camera left/right) |
| **↑ ↓** | Move point ±1 m forward/back (camera view) |
| **Shift+↑ ↓** | Move point ±1 m on **Y** |
| **Shift+← →** | Bank ±5° (inverted: ← decreases, → increases) |
| **PgUp / PgDn** | Spawn car at next / previous control point |

Edits the **next checkpoint** control point (same index as the yellow checkpoint ahead). Changes rebuild the road live. Rejected moves keep spacing (≥8 m), grade (≤35%), turn angle, and height limits.

Copy the `?track=…` string from the HUD or run `DriveVR2.getEditorTrack()` in the console.

## City environment

- **Default:** VRrunner giant city (`VRrunner/3d/scene.gltf` + `scene.bin`, 100× scale, mesh BVH building collision).
- **Legacy blocks:** `?city=procedural`

## Fly camera

- **C** — toggle fly / driving camera
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
| `audio/machina-tobias-voigt-main-version-19314-02-39.mp3` | Background music (engine SFX are procedural) |
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
