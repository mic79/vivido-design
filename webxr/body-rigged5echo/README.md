# body-rigged5echo — VR body foundation + Lone Echo

Fork of `body-rigged5` (zdm2 scene, fps HUD, Box3D stack) with the working **Lone Echo** character path from `body-rigged4echo`.

| Id | Model | Notes |
|---|---|---|
| `echo` (default) | `Stand_Up_mixamo.fbx` | Blue local / orange mirror · albedo + normal + metallic + roughness |
| `ybot` | `character.glb` | Original Mixamo YBot |

| Map | Asset | Notes |
|---|---|---|
| `zdm2` (default) | `zdm2_baked.glb` | Godot unlit bake |
| `surge` | `maps/Surge_Minimap.fbx` | Echo Combat Surge @ Demo-Viewer full size (Unity ×56 × cm→m) |

## Quick start

Serve this folder, then open:

- Echo: `index.html` or `index.html?model=echo`
- YBot: `index.html?model=ybot`
- Surge map: `index.html?map=surge`
- Zero-G: `index.html?mode=zerog`
- Old playground: `index.html?demo=1`

Toggle character: UI **YBot** / **Lone Echo**, keyboard **V**, VR panel **Character**, or:

```js
window.BodyRiggedCharacter.set('echo'); // or 'ybot'
window.BodyRiggedCharacter.toggle();
```

Toggle map: UI **zdm2** / **Surge**, keyboard **N**, VR panel **Map**, or:

```js
window.BodyRiggedEnvironmentMap.set('surge'); // hot-swaps in-session (keeps VR)
window.BodyRiggedEnvironmentMap.toggle();
```

## Local assets

- `Stand_Up_mixamo.fbx` + `textures/echo/` — Echo unit + Demo-Viewer maps
- `character.glb` — YBot toggle target
- `zdm2_baked.glb` — default scene (from body-rigged5)
- `maps/Surge_Minimap.fbx` — Echo Combat Surge (from Demo-Viewer)
- `kneonBOT_albedo.jpg` — remapped for absolute paths baked into Surge FBX

## Notes

Echo FBX carries GeometricTranslation / bind-roll baggage; runtime handles unit scale, materials, shatter bake space, and ragdoll retarget (`echoNoHinge` / hips bind). Prefer a cleaned GLB long-term.

Map switches **hot-swap** the environment trimesh in-place so the WebXR session is not torn down.