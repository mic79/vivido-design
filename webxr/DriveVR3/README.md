# DriveVR3

Fork of DriveVR2 focused on a **top-down nav mesh** for the VRrunner city: simple land/water classification, then exclude building footprints seen from above (grey on the overlay). No bridge/underpass pass yet.

Serve this folder with any static HTTP server (required for GLTF, audio, and ES modules).

```bash
# Example (from DriveVR3/)
npx --yes serve .
# Open http://localhost:3000/
```

## Nav mesh (top-down)

1. **Water** — ray hits water materials / named water meshes.
2. **Street floor** — lowest up-facing land hit (same idea as older simple builds).
3. **Top-down ray** — from above the city bbox; if the first hit is much higher than the street floor, the cell is **building** (grey), not drivable.

| Param | Default | Effect |
|--------|---------|--------|
| `?navmode=topdown` | (default) | Top-down building exclusion |
| `?navmode=legacy` | | DriveVR2-style 1 m cube occupancy |
| `?navtopgap=2.5` | 2.5 m | Roof must be this far above street to count as building |
| `?navcell=2` | 2 m | Grid cell size |
| `?navbundle=0` | | Skip bundled `.nav.bin` (force rebuild) |

**Shift+N** — rebuild nav. **N** — toggle overlay. **Ctrl+Shift+E** — export `vrrunner-city.nav.bin` (must rebuild with v9td key before shipping).

Overlay colours: **green** = main drivable component, **olive** = other drivable islands, **grey** = land column under a building, **blue** = water.

## Custom track (`?track=`)

Same as DriveVR2 — pipe-separated control points in **world meters**.

```
?track=x,y,z|x,y,z,bank|...
```

Copy the `?track=…` string from the HUD or run `DriveVR3.getEditorTrack()` in the console.

## City environment

- **Default:** VRrunner giant city (`VRrunner/3d/scene.gltf` + `scene.bin`, 100× scale, mesh BVH building collision).
- **Legacy blocks:** `?city=procedural`

## Dev helpers (browser console)

```javascript
DriveVR3.getDefaultTrackParam()
DriveVR3.getTrackInfo()
```

`DriveVR2` is an alias for `DriveVR3` in this build.
