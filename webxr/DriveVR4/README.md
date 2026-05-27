# DriveVR4 — City chase (WebXR)

Fork of DriveVR3 focused on **free-roam city driving** and **toggleable chase mode**. Track racing and track editor are removed; **multiplayer (PeerJS) is kept**.

## Play

Open `index.html` (local server recommended). Default city: `VRrunner/3d/scene.gltf`.

- **WASD** / VR thumbsticks — drive  
- **B** — menu (single/multi, chase, music)  
- **C** — camera mode  
- **R** — reset car  
- **?chase=1** — start with chase enabled (single-player only)  

## Performance

`js/chaseWorld.js` provides spatial broadphase for vehicle collisions, physics substep budgets, and AI throttling.

Quest profile: fewer pursuers, slightly lower physics substeps. City **Bullet** walkable meshes are built on Quest (same as DriveVR3) so wheels get street traction. Optional `?skipcitybullet=1` disables that build (debug only; car may not drive).

## URL params

- `?mirror=0` — disable rearview  
- `?navmini=120` — minimap radius (0 = off)  
- `?chase=1` — chase on at start (single-player)  
