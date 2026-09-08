"""
Seat UE rocks on the skirmish crater moon and export a combined GLB for RTSVR5 1v1.

Blender 5.x (headless):
  "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" --background --python
    RTSVR5/scripts/seat-rocks-on-crater.py

Inputs:
  assets/terrain/terrain-skirmish-ue-lm.glb   (Moon_0 plate + Moon_1 skirts)
  assets/terrain/scifi-rts-rocks.glb          (SM_Rock / Cliff / Dirt / Mineral)

Outputs:
  assets/terrain/terrain-skirmish-1v1.glb     (Moon_* + Prop_*)
  export/skirmish-1v1-placements.json         (UE re-import transforms, meters, Y-up)
"""
from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)
MOON_GLB = os.path.join(ROOT, "assets", "terrain", "terrain-skirmish-ue-lm.glb")
ROCKS_GLB = os.path.join(ROOT, "assets", "terrain", "scifi-rts-rocks.glb")
OUT_GLB = os.path.join(ROOT, "assets", "terrain", "terrain-skirmish-1v1.glb")
OUT_JSON = os.path.join(ROOT, "export", "skirmish-1v1-placements.json")

# Fit rocks into the playable plate (moon plate is ±100 m). Leave a clear fight bowl.
TARGET_SPAN_M = 184.0  # ~0.92 * 200
CLEAR_RADIUS_M = 42.0  # sparse / remove inside HQ fight zone
SINK_M = 0.15  # bury slightly so feet don't float
MAX_TILT_DEG = 18.0  # blend toward surface normal, keep mostly upright
RAY_H = 400.0


def log(msg: str) -> None:
    print("[seat-rocks]", msg)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for b in list(block):
            block.remove(b)


def import_glb(path: str) -> list:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def world_bbox(objs) -> tuple[Vector, Vector] | None:
    mins = Vector((1e18, 1e18, 1e18))
    maxs = Vector((-1e18, -1e18, -1e18))
    any_ok = False
    for o in objs:
        if o.type != "MESH":
            continue
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            mins.x = min(mins.x, w.x)
            mins.y = min(mins.y, w.y)
            mins.z = min(mins.z, w.z)
            maxs.x = max(maxs.x, w.x)
            maxs.y = max(maxs.y, w.y)
            maxs.z = max(maxs.z, w.z)
            any_ok = True
    return (mins, maxs) if any_ok else None


def mesh_objects(objs):
    return [o for o in objs if o.type == "MESH"]


def is_moon(name: str) -> bool:
    n = name or ""
    return n.startswith("Moon_") or n.startswith("rts-moon-")


def is_rock_prop(name: str) -> bool:
    n = (name or "").lower()
    return any(k in n for k in ("rock", "cliff", "dirt", "mineral"))


def ensure_moon_names(objs) -> None:
    """Keep / restore Moon_0 / Moon_1 labels the runtime already filters on."""
    moons = [o for o in mesh_objects(objs) if is_moon(o.name)]
    if len(moons) >= 2:
        return
    # Fallback: largest XY footprint = plate, next = skirts
    meshes = mesh_objects(objs)
    scored = []
    for o in meshes:
        bb = world_bbox([o])
        if not bb:
            continue
        mn, mx = bb
        area = (mx.x - mn.x) * (mx.y - mn.y)
        scored.append((area, o))
    scored.sort(key=lambda t: t[0])
    if not scored:
        return
    if len(scored) == 1:
        scored[0][1].name = "Moon_0"
        return
    # smallest of the two biggest is plate (±100); largest area is skirts
    plate = scored[-2][1] if scored[-1][0] > scored[-2][0] * 1.5 else scored[0][1]
    skirts = scored[-1][1] if plate is not scored[-1][1] else scored[-2][1]
    # Prefer tighter ±100 as plate
    for _area, o in scored:
        bb = world_bbox([o])
        if not bb:
            continue
        mn, mx = bb
        span = max(mx.x - mn.x, mx.y - mn.y)
        if 150 < span < 250:
            plate = o
            break
    for o in meshes:
        if o is plate:
            o.name = "Moon_0"
        elif o is skirts or (is_moon(o.name) and o is not plate):
            o.name = "Moon_1"


def build_depsgraph():
    return bpy.context.evaluated_depsgraph_get()


def ray_moon(depsgraph, origin: Vector, direction: Vector):
    return bpy.context.scene.ray_cast(depsgraph, origin, direction)


def seat_rocks(moon_objs, rock_objs) -> list[dict]:
    moon_meshes = [o for o in mesh_objects(moon_objs) if o.name.startswith("Moon_")]
    # Prefer plate for seating; fall back to all moon meshes
    plate = next((o for o in moon_meshes if o.name.startswith("Moon_0")), None)
    targets = [plate] if plate else moon_meshes
    for o in targets:
        o.hide_set(False)

    # Hide rocks during cast so they don't hit each other
    for o in rock_objs:
        o.hide_set(True)
    for o in moon_objs:
        if o not in targets:
            o.hide_set(True)

    depsgraph = build_depsgraph()
    placements = []
    kept = 0
    dropped_clear = 0
    missed = 0

    max_tilt = math.radians(MAX_TILT_DEG)

    for o in mesh_objects(rock_objs):
        if not is_rock_prop(o.name):
            o.hide_set(True)
            continue
        o.hide_set(False)
        loc = o.matrix_world.translation.copy()
        # Blender Y-up after glTF import: XZ ground plane uses X/Y horizontal? 
        # glTF is Y-up: X right, Y up, Z toward camera. After import, ground is XZ
        # with Y up — same as Three.
        x, y, z = loc.x, loc.y, loc.z
        r = math.hypot(x, z)
        if r < CLEAR_RADIUS_M:
            # Soft: keep a few small dirt piles near edges of clear zone only if r>28
            n = (o.name or "").lower()
            if "dirt" not in n or r < 28.0:
                bpy.data.objects.remove(o, do_unlink=True)
                dropped_clear += 1
                continue

        origin = Vector((x, RAY_H, z))
        direction = Vector((0.0, -1.0, 0.0))
        hit, hit_loc, hit_nor, _face, hit_obj, _mat = ray_moon(depsgraph, origin, direction)
        if not hit or hit_obj is None or not str(hit_obj.name).startswith("Moon_"):
            # Try slightly jittered rays
            hit = False
            for dx, dz in ((0.5, 0), (-0.5, 0), (0, 0.5), (0, -0.5), (1, 1), (-1, -1)):
                origin2 = Vector((x + dx, RAY_H, z + dz))
                hit, hit_loc, hit_nor, _face, hit_obj, _mat = ray_moon(
                    depsgraph, origin2, direction
                )
                if hit and hit_obj is not None and str(hit_obj.name).startswith("Moon_"):
                    break
                hit = False
            if not hit:
                bpy.data.objects.remove(o, do_unlink=True)
                missed += 1
                continue

        # Upright world up is +Y
        up = Vector((0.0, 1.0, 0.0))
        n = hit_nor.normalized()
        if n.dot(up) < 0:
            n = -n
        # Blend normal toward up so rocks don't lie flat on steep crater walls
        blend = min(1.0, max_tilt / max(1e-4, math.acos(max(-1.0, min(1.0, n.dot(up))))))
        # Simpler: slerp-ish toward up by fixed weight
        n_blend = (n * 0.35 + up * 0.65).normalized()

        # Preserve yaw from original rotation
        mw = o.matrix_world.copy()
        # Build basis: Y = n_blend, X = yaw-forward × Y
        forward = mw.to_3x3() @ Vector((0.0, 0.0, 1.0))
        forward.y = 0.0
        if forward.length < 1e-4:
            forward = Vector((1.0, 0.0, 0.0))
        else:
            forward.normalize()
        x_axis = forward.cross(n_blend)
        if x_axis.length < 1e-4:
            x_axis = Vector((1.0, 0.0, 0.0)).cross(n_blend)
        x_axis.normalize()
        z_axis = x_axis.cross(n_blend).normalized()
        rot = Matrix((x_axis, n_blend, z_axis)).transposed().to_4x4()

        new_loc = hit_loc - n_blend * SINK_M
        scale = mw.to_scale()
        scl = Matrix.Diagonal((scale.x, scale.y, scale.z, 1.0))
        o.matrix_world = Matrix.Translation(new_loc) @ rot @ scl

        base = o.name.split(".")[0]
        if not base.startswith("Prop_"):
            o.name = "Prop_" + base
        kept += 1
        placements.append(
            {
                "name": o.name,
                "meshHint": base.replace("Prop_", ""),
                "translation": [new_loc.x, new_loc.y, new_loc.z],
                "scale": [scale.x, scale.y, scale.z],
                "basisY": [n_blend.x, n_blend.y, n_blend.z],
            }
        )
        o.hide_set(True)  # don't block later rays

    # Unhide survivors
    for o in list(bpy.data.objects):
        if o.type == "MESH":
            o.hide_set(False)

    log(f"seated={kept} dropped_clear={dropped_clear} missed={missed}")
    return placements


def fit_rocks_to_plate(rock_objs) -> None:
    """
    Scale/center from **instance origins** only (not mesh bound boxes).
    Bound boxes blow up when a few cliffs carry huge local scales / water planes.
    """
    pts = []
    for o in mesh_objects(rock_objs):
        if not is_rock_prop(o.name):
            # Drop water / non-scenery from the 1v1 crater kit
            if "water" in (o.name or "").lower():
                bpy.data.objects.remove(o, do_unlink=True)
            continue
        t = o.matrix_world.translation
        pts.append((t.x, t.z, o))
    if len(pts) < 8:
        log(f"rocks fit: too few points ({len(pts)})")
        return
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    minx, maxx = min(xs), max(xs)
    minz, maxz = min(zs), max(zs)
    cx = 0.5 * (minx + maxx)
    cz = 0.5 * (minz + maxz)
    span = max(maxx - minx, maxz - minz, 1.0)
    s = TARGET_SPAN_M / span
    log(
        f"rocks fit: n={len(pts)} center=({cx:.1f},{cz:.1f}) "
        f"span={span:.1f} scale={s:.4f}"
    )
    # Bake scale+recenter into each object's world matrix (keep relative layout).
    for o in mesh_objects(list(bpy.data.objects)):
        if not is_rock_prop(o.name):
            continue
        mw = o.matrix_world.copy()
        t = mw.translation
        new_t = Vector(((t.x - cx) * s, t.y * s, (t.z - cz) * s))
        rot = mw.to_3x3()
        scale = mw.to_scale() * s
        # Recompose: T * R * S
        x_axis = rot @ Vector((1, 0, 0))
        y_axis = rot @ Vector((0, 1, 0))
        z_axis = rot @ Vector((0, 0, 1))
        if x_axis.length > 1e-8:
            x_axis.normalize()
        if y_axis.length > 1e-8:
            y_axis.normalize()
        if z_axis.length > 1e-8:
            z_axis.normalize()
        basis = Matrix(
            (
                (x_axis.x * scale.x, y_axis.x * scale.y, z_axis.x * scale.z, new_t.x),
                (x_axis.y * scale.x, y_axis.y * scale.y, z_axis.y * scale.z, new_t.y),
                (x_axis.z * scale.x, y_axis.z * scale.y, z_axis.z * scale.z, new_t.z),
                (0.0, 0.0, 0.0, 1.0),
            )
        )
        o.parent = None
        o.matrix_world = basis
    bpy.context.view_layer.update()


def export_glb(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Select only Moon_* and Prop_* meshes
    bpy.ops.object.select_all(action="DESELECT")
    count = 0
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        if o.name.startswith("Moon_") or o.name.startswith("Prop_"):
            o.select_set(True)
            count += 1
        else:
            o.select_set(False)
    log(f"export meshes={count} -> {path}")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )


def main() -> int:
    if not os.path.isfile(MOON_GLB):
        log(f"missing moon {MOON_GLB}")
        return 1
    if not os.path.isfile(ROCKS_GLB):
        log(f"missing rocks {ROCKS_GLB}")
        return 1

    clear_scene()
    moon_objs = import_glb(MOON_GLB)
    log(f"imported moon objects={len(moon_objs)}")
    ensure_moon_names(moon_objs)
    # Canonical names for ray hits + RTSVR5 Moon_* filter
    for o in mesh_objects(list(bpy.data.objects)):
        if o.name.startswith("Moon_0"):
            o.name = "Moon_0"
        elif o.name.startswith("Moon_1"):
            o.name = "Moon_1"
        log(f"  moon mesh {o.name}")

    rock_objs = import_glb(ROCKS_GLB)
    log(f"imported rock objects={len(rock_objs)}")
    fit_rocks_to_plate(rock_objs)

    # Refresh moon list after rock import (scene grew)
    moon_now = [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Moon_")]
    rock_now = [
        o
        for o in bpy.data.objects
        if o.type == "MESH" and is_rock_prop(o.name) and not o.name.startswith("Moon_")
    ]
    placements = seat_rocks(moon_now, rock_now)

    export_glb(OUT_GLB)
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(
            {
                "mapSize": 200,
                "targetSpanM": TARGET_SPAN_M,
                "clearRadiusM": CLEAR_RADIUS_M,
                "sinkM": SINK_M,
                "count": len(placements),
                "placements": placements,
                "glb": os.path.relpath(OUT_GLB, ROOT).replace("\\", "/"),
                "note": "Y-up meters; Moon_0=plate Moon_1=skirts; Prop_*=scenery",
            },
            f,
            indent=2,
        )
    size = os.path.getsize(OUT_GLB) if os.path.isfile(OUT_GLB) else 0
    log(f"done size_mb={size / 1e6:.1f} placements={len(placements)} json={OUT_JSON}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:
        log(f"FAIL {err}")
        raise
