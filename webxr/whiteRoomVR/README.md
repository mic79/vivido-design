# White Room VR

Quest-ready futuristic glossy white room: Blender bake → GLB → Three.js WebXR.

## Assets (project-local only)

| File | Purpose |
|------|---------|
| `white_room.glb` | Baked room (2048² Combined maps) |
| `room_env.png` | Equirect **of this room** (reflection probe) |
| `bake_maps/*.png` | Per-surface bakes |
| `js/main.js` | Viewer |

## How reflections work (no fake mirror room)

- **No `THREE.Reflector`** — that was cloning the room upside-down under the floor.
- **Floor:** Combined bake (glossy light-panel streaks from Cycles) + soft `envMap` from `room_env.png`.
- **Walls/ceiling:** Unlit baked maps (full brightness).
- **Bloom:** Selective, emissive strips only.

## Preview

```bash
python -m http.server 8080
# http://localhost:8080/whiteRoomVR/
```

## Rebuild

```bash
blender --background --python whiteRoomVR/blender/build_and_bake_white_room.py
```
