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

Quest profile: fewer pursuers, **10** physics substeps (same as DriveVR2/3 — required for wheel traction). City Bullet walkable meshes are built on Quest; a y≈0 fallback plane stays for mesh gaps. Optional `?skipcitybullet=1` disables mesh build (debug only).

## URL params

- `?mirror=0` — disable rearview  
- `?navmini=120` — minimap radius (0 = off)  
- `?chase=1` — chase on at start (single-player)  
