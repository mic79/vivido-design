# VRrunner city nav map (bundled)

Pre-built drivable grid for `VRrunner/3d/scene.gltf`. Chase and pathfinding load this instead of raycasting 53M cells.

## Ship with the game

**Only commit this file:**

`vrrunner-city.nav.opt.bin` — **DV2N fmt=4** (~0.6–2 MB gzip)

Regenerate from legacy source:

```bash
python optimize-nav-fmt4.py vrrunner-city.nav.bin vrrunner-city.nav.opt.bin
```

Do **not** ship `vrrunner-city.nav.bin` (fmt=2, ~350 MB). Use `?navlegacy=1` locally if you still have it.

## Runtime load order

1. `VRrunner/nav/vrrunner-city.nav.opt.bin` (fmt=4)
2. Browser IndexedDB (fmt=4 gzip)
3. Build with Shift+N only if missing (`?navmap=auto`)

Nav **logic** loads without building the full minimap texture. Overlay canvas is created only when `?navmap=1` or you press **N**.

## URL options

| Param | Effect |
|--------|--------|
| `?navmap=1` | Show nav overlay; build overlay texture on load |
| `?navbundle=0` | Skip bundled file |
| `?navlegacy=1` | Also try legacy `vrrunner-city.nav.bin` |
| `?navexport=1` | Download fmt=4 when nav ready |

## fmt=4 contents

- Varint-encoded walk cell indices + int16 heights
- Water as **bitmap** (~7 MB raw), not 21M (index,float) pairs
- gzip payload

Console: `exportOptimizedNavBundle()` after nav is ready.
