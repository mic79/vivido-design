# VRdrift

WebXR prototype **inspired by** Orion Drift locomotion — not a port. It reuses patterns from BattleVR (thumbstick yaw, collision resolve) and VR Knockout (rolling body ball visual), but movement is driven by **arm-push + palm skate/carve**, selective grip rails, and momentum releases.

## Run

Serve over HTTPS, open `VRdrift/index.html`, Enter VR.

## Controls

| Input | Action |
|--------|--------|
| **Push hands on walls/floor** | Primary movement (arm-push) |
| **Palm on `drift-surface`** | Skate / carve |
| **Right thumbstick X** | Turn body |
| **Grip on `drift-grip`** | Anchor on rails |
| **Grip on plain surface (moving)** | Brake; release fast for wall-jump boost |
| **B / Y** | Wrist thrusters (point hand, boost) |
| **X** | Menu |

## Status

Early prototype. Missing vs real Orion Drift: full rolling-ball Cannon avatar, station-scale arenas, fuel/stamina, multiplayer body hits, and tuned constants from the commercial game.

## Files

- `js/drift-locomotion.js` — Orion-style movement
- `js/collision-resolve.js` — body-ball vs surfaces
- `js/mixamo-body-avatar.js` — IK body (`../assets/Y Bot.fbx`)
- `js/config.js` — tuning
