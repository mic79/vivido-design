# body-rigged5echo — VR body foundation + Lone Echo

Fork of `body-rigged5` (zdm2 scene, fps HUD, Box3D stack) with the working **Lone Echo** character path from `body-rigged4echo`.

| Id | Model | Notes |
|---|---|---|
| `echo` (default) | `Stand_Up_mixamo.fbx` | Blue local / orange mirror · albedo + normal + metallic + roughness |
| `ybot` | `character.glb` | Original Mixamo YBot |

## Quick start

Serve this folder, then open:

- Echo: `index.html` or `index.html?model=echo`
- YBot: `index.html?model=ybot`
- Zero-G: `index.html?mode=zerog`
- Old playground: `index.html?demo=1`

Toggle character: UI **YBot** / **Lone Echo**, keyboard **V**, VR panel **Character**, or:

```js
window.BodyRiggedCharacter.set('echo'); // or 'ybot'
window.BodyRiggedCharacter.toggle();
```

## Local assets

- `Stand_Up_mixamo.fbx` + `textures/echo/` — Echo unit + Demo-Viewer maps
- `character.glb` — YBot toggle target
- `zdm2_baked.glb` — default scene (from body-rigged5)

## Notes

Echo FBX carries GeometricTranslation / bind-roll baggage; runtime handles unit scale, materials, shatter bake space, and ragdoll retarget (`echoNoHinge` / hips bind). Prefer a cleaned GLB long-term.
