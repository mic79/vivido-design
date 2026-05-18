# VRragdoll

WebXR + **Three.js** + **Rapier** + the **same skinned character** as [rapierjs-ragdoll](https://github.com/mattvb91/rapierjs-ragdoll) (`character.glb` from jsDelivr). Bone names match the physics template so ragdoll + idle animation work like the reference demo.

**Player body** uses the same **VRrunner** pattern: `cameraRig` → `crouchViewGroup` → camera + XR controllers/grips, plus `bodyIkAvatar.js` (Mixamo Y Bot IK). **NPC** uses the ragdoll GLB only.

## VR setup

- **`local-floor`** reference space; rig at origin, NPC at **Z = −1.25 m** (in front along −Z).
- Controllers parented under **`crouchViewGroup`** so hands move with thumbstick locomotion.
- **Left stick**: move (head-relative). **Right stick X**: turn rig.
- **Squeeze**: grab limb (enters ragdoll if idle; each hand can hold a part). **Y** (either controller): reset NPC to standing spawn. **Trigger** (edge): stand when calm (not while holding).

## Controls

| Input | Action |
|--------|--------|
| **R** | Ragdoll NPC |
| **G** / **Shift+G** | Stand when calm / force stand |
| **Space** | Push torso (desktop) |
| **VR squeeze** | Grab nearest limb (per hand; starts ragdoll) |
| **VR Y** | Reset NPC to standing at spawn |
| **VR trigger** (edge) | Stand when calm (hands released) |
| **Y** (desktop) | Reset NPC to spawn |
| **VR left stick** | Move |
| **VR right stick X** | Turn |

## Running

Serve `VRragdoll/` (or parent `WebXR/`) over HTTP. Open `index.html`.

**Player model:** `3d/Y Bot.fbx` (bundled copy of VRrunner’s Mixamo Y Bot). If the FBX fails to load, VR still works; the IK body stays hidden until load succeeds.

**NPC:** `character.glb` from CDN; Draco decoder from Google CDN.

## Files

- `js/main.js` — scene, VRrunner rig, locomotion, NPC load
- `js/bodyIkAvatar.js` — Mixamo body IK (from VRrunner)
- `js/xr-input.js` — Quest gamepad pairing
- `js/ragdoll-npc.js` — Rapier ragdoll (ported from `Ragdoll.ts`)

## References

- [mattvb91/rapierjs-ragdoll](https://github.com/mattvb91/rapierjs-ragdoll)
- `VRrunner/` — proven Three.js WebXR + body IK
