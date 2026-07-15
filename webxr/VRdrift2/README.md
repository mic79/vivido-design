# VRdrift2 (Box3D)

Orion Drift–style WebXR locomotion on **box3d.js**, with VRdrift visuals/UI restored.

## Self-contained deploy

Everything needed at runtime lives **inside this folder** (no `../assets` dependencies):

| Asset | Path |
|--------|------|
| Character (CapVR GLB) | `character.glb` |
| Thruster / roll / impact SFX | `audio/` |

Deploy the whole `VRdrift2/` directory (including `character.glb` ~2.7MB and `audio/`).

## Run

Serve this folder (or the parent WebXR tree) over HTTPS/localhost. Open `index.html`. Enter VR. **Menu: X**.

## What's included

- Box3D body-ball locomotion + palm skate
- Mixamo-compatible body avatar (`character.glb`)
- Soccer-ball textures, floor grid, shadows
- Full arena (ramp slab, parkour, rails, ceiling)
- In-VR menu (Solo / Host / Join / lobby / rig height)
- Right-stick turn, B/Y thrusters, grip rails
- Multiplayer Mixamo remotes + touch-owned ball sync

## Controls

| Input | Action |
|--------|--------|
| Palms on surfaces | Skate / push |
| Grip on cyan rails | Anchor |
| Right stick | Turn |
| B / Y | Thrusters |
| X | Menu |
