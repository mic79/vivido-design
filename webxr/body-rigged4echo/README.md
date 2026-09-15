# body-rigged4echo — VR character foundation + Lone Echo

Fork of `body-rigged4` with a Mixamo-rigged **Lone Echo** player (`Stand_Up_mixamo.fbx`) and textures from [Demo-Viewer](https://github.com/robidasdavid/Demo-Viewer/tree/master/Demo%20Viewer/Assets/Textures).

Toggle at runtime between:

| Id | Model | Notes |
|---|---|---|
| `echo` (default) | `Stand_Up_mixamo.fbx` | Blue local / orange mirror · albedo + normal + metallic + roughness |
| `ybot` | `character.glb` | Original body-rigged4 Mixamo YBot |

## Quick start

Serve this folder over HTTPS / localhost, then open:

- Echo (default): `index.html` or `index.html?model=echo`
- YBot: `index.html?model=ybot`
- Zero-G: `index.html?mode=zerog`

Toggle character: UI **YBot** / **Lone Echo** buttons, keyboard **V**, VR panel **Character**, or:

```js
window.BodyRiggedCharacter.set('echo'); // or 'ybot'
window.BodyRiggedCharacter.toggle();
```

Scene event: `character-model-changed` → `{ id, path }`.

## Local assets

- `Stand_Up_mixamo.fbx` — Mixamo-retargeted Echo unit (from UE5 EchoVR folder)
- `kneonBOT_albedo.jpg` — FBX-embedded albedo alias (blue team)
- `textures/echo/` — Demo-Viewer maps:
  - `BlueEchoTex.jpg` / `OrangeEchoTex.jpg`
  - `Echo_unit_normal_ACTUAL.png`
  - `echoman_metalic.png` / `echoman_roughness.png`
  - `EchoHeight.jpg` (height reference; unused at runtime)
- `character.glb` — original YBot (kept for toggle)

## Echo FBX vs YBot GLB (important)

YBot (`character.glb`) is a clean Mixamo export: mesh at origin, identity forearm/hand bind rolls.

Echo (`Stand_Up_mixamo.fbx`) still carries UE/Mixamo FBX baggage:
- Skinned mesh **GeometricTranslation** ≈ `(-871, -399, 0)`
- Non-axis-aligned arm bone rolls (forearm/hand local quats ≠ identity)

**Runtime (model-agnostic):**
- Arm IK: absolute Mixamo aim; forearm twist from **controller × grip** (same frame as the hand — not raw controller); full twist absorb so wrists stay swing-only
- Upper-arm roll matched to forearm (+ re-aim) so elbows are not cross-twisted
- π-fold + unwrap for continuous roll; no world-down lock
- Crouch: same leg+spine path as YBot; Echo foot IK plants only when crouching still

**Durable asset fix** (still preferred): in Blender, clear GeometricTranslation, reset arm bone rolls to Mixamo identity, export **GLB**.

## Everything else

Same grounded / zero-g / Box3D / ragdoll foundation as `body-rigged4`. See that README for locomotion and gravity-mode details.
