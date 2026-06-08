# DriveVR5 — Forest road (WebXR)

Fork of DriveVR4 focused on **free-roam driving on a single forest dirt-road GLB** and **toggleable chase mode**. The VRrunner city model and city nav are not loaded. **Multiplayer (PeerJS) is kept**.

## Play

Open `index.html` (local server recommended). Environment: `assets/free_dirt_road_through_forest.glb`.

- **WASD** / VR thumbsticks — drive  
- **B** — menu (single/multi, chase, music)  
- **C** — camera mode  
- **R** — reset car  
- **?chase=1** — start with chase enabled (single-player only)  

## Performance

- No dynamic shadows (desktop and Quest)
- Shorter view distance and fog tuned for the forest scene
- City nav map / minimap off by default (`?navmini=120` to enable)
- `js/chaseWorld.js` — spatial broadphase, physics substep budgets, AI throttling

Walkable mesh tris → Bullet bodies for wheel traction; BVH hull push for environment depenetrate.

## URL params

- `?mirror=0` — disable rearview  
- `?navmini=120` — minimap radius (off by default)  
- `?chase=1` — chase on at start (single-player)  
- `?skyhorizon=7a9eb0` — sky / fog color (hex, no `#`)  
