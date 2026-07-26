# body-rigged4 — VR character foundation

Reusable Mixamo + Box3D body foundation for WebXR apps: **grounded**, **zero-g**, or **both**.

Built from `body-rigged3`, with gravity-mode adapters so apps do not need a second body fork.

## Quick start

Serve this folder over HTTPS / localhost, then open:

- Grounded: `index.html` or `index.html?mode=grounded`
- Zero-G: `index.html?mode=zerog`

Toggle at runtime: UI buttons, keyboard **G**, VR left-controller **X**, or:

```js
window.BodyRiggedGravity.setMode('zerog');   // or 'grounded'
window.BodyRiggedGravity.toggle();
window.BodyRiggedGravity.allowSwitch = false; // lock mode for a ship title
```

Scene event: `gravity-mode-changed` → `{ previous, mode }`.

## Architecture

| Layer | Role |
|---|---|
| Body / hands / grab / ragdoll | Shared (`mixamo-body`, Box3D modules) |
| `gravity-mode.js` | Mode API + URL + scene events |
| Grounded locomotion | Existing `leg-ik-world` walk / crouch / floor IK |
| `zerog-locomotion.js` | Thrusters, boost, airbrake, yaw, 3D fling |
| `zerog-legs.js` | Procedural floating leg poses |

Apps that are **gravity-only** or **space-only** keep the same character stack and pin a mode. Dual-mode apps leave `allowSwitch: true`.

## Zero-G controls

| Input | Action |
|---|---|
| X (left) | Toggle grounded ↔ zero-g |
| Y / B | Thrusters (along controller −Y) |
| Left stick click | Boost (look direction) |
| Right stick click | Airbrake (hold) |
| Right stick X / Z-X | Yaw player (grounded + zero-g) |
| Surface grab release | Push / fling (3D impulse into float velocity) |
| Desktop | Q/E thrusters · T boost · C brake · Z/X yaw · G mode toggle |

Grounded shortcuts still apply when not in zero-g: F body disarm, R ragdoll, WASD walk.

## Embedding in another A-Frame app

1. Copy `js/` + character assets.
2. Include scripts in order: collision → ragdoll → `gravity-mode` → physics world → `leg-ik-box3d` → `zerog-legs` → `zerog-locomotion` → grab.
3. Put `gravity-mode` on the scene and `zerog-locomotion` on the player rig.
4. Set initial mode via attribute, URL, or `BodyRiggedGravity.setMode(...)`.

Feel / control mapping is adapted from BattleVR / BoltVR / `body-rigged-zerog2`; motion uses the Box3D capsule mover.
