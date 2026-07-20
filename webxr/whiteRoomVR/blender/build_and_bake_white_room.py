"""
Build + bake a Quest-ready futuristic glossy white room (Blender 4/5).

Creates geometry, cyan-white materials, recessed emissive light strips,
Cycles Combined bake for walls/ceiling, exports GLB + saves .blend.

Run headless:
  blender --background --python build_and_bake_white_room.py

Env overrides:
  WHITE_ROOM_SAMPLES=96
  WHITE_ROOM_TEX=1024
  WHITE_ROOM_QUICK=1
"""

from __future__ import annotations

import math
import os
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

try:
    SCRIPT_DIR = Path(__file__).resolve().parent
except NameError:
    SCRIPT_DIR = Path.cwd()

OUT_DIR = SCRIPT_DIR.parent
BLEND_PATH = OUT_DIR / "white_room.blend"
GLB_PATH = OUT_DIR / "white_room.glb"
ENV_PATH = OUT_DIR / "room_env.png"
BAKE_DIR = OUT_DIR / "bake_maps"

TEX_SIZE = int(os.environ.get("WHITE_ROOM_TEX", "2048"))
BAKE_SAMPLES = int(os.environ.get("WHITE_ROOM_SAMPLES", "160"))
QUICK = os.environ.get("WHITE_ROOM_QUICK", "").strip() in ("1", "true", "True", "yes")
MARGIN = 8
BAKE_EXPOSURE = float(os.environ.get("WHITE_ROOM_EXPOSURE", "0.14"))

ROOM_W = 7.0
ROOM_H = 3.6
ROOM_D = 14.0

BASE_RGB = (0.88, 0.94, 0.95)
FLOOR_RGB = (0.84, 0.91, 0.93)
EMISSIVE_RGB = (1.0, 1.0, 1.05)


def log(msg: str) -> None:
    print(f"[whiteRoom] {msg}", flush=True)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for block in list(coll):
            coll.remove(block)
    for img in list(bpy.data.images):
        if not img.users:
            bpy.data.images.remove(img)


def new_mat(name: str, *, color, roughness: float, metallic: float = 0.0,
            emission=None, emission_strength: float = 0.0) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None and emission_strength > 0:
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        elif "Emission" in bsdf.inputs:
            bsdf.inputs["Emission"].default_value = (*emission, 1.0)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emission_strength
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_quad(name: str, corners, mat: bpy.types.Material) -> bpy.types.Object:
    """Create a single quad. ``corners`` are 4 world-space verts, winding = outward
    from face then we flip so normal points into the room (toward origin-ish)."""
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)

    bm = bmesh.new()
    verts = [bm.verts.new(Vector(c)) for c in corners]
    face = bm.faces.new(verts)
    # Full-atlas UVs
    uv_layer = bm.loops.layers.uv.new("UVMap")
    uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    for loop, uv in zip(face.loops, uvs):
        loop[uv_layer].uv = uv
    # Ensure normal points toward room center (0,0,ROOM_H/2)
    center = Vector((0.0, 0.0, ROOM_H * 0.5))
    face.normal_update()
    face_center = face.calc_center_median()
    if (center - face_center).dot(face.normal) < 0:
        face.normal_flip()
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj.data.materials.append(mat)
    return obj


def add_box(name: str, size, location, mat: bpy.types.Material) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    # Simple UV for emissive boxes
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def find_principled(mat: bpy.types.Material):
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def prepare_bake_target(mat: bpy.types.Material, img: bpy.types.Image) -> None:
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    for n in list(nodes):
        if n.name.startswith("BakeTex_") or n.name.startswith("BakeUV_"):
            nodes.remove(n)
    tex = nodes.new("ShaderNodeTexImage")
    tex.name = "BakeTex_" + mat.name
    tex.image = img
    tex.location = (-500, 200)
    uv = nodes.new("ShaderNodeUVMap")
    uv.name = "BakeUV_" + mat.name
    uv.uv_map = "UVMap"
    uv.location = (-700, 200)
    links.new(uv.outputs["UV"], tex.inputs["Vector"])
    for n in nodes:
        n.select = False
    tex.select = True
    nodes.active = tex


def apply_baked_to_basecolor(mat: bpy.types.Material, img: bpy.types.Image) -> None:
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    links.new(uv.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    elif "Specular" in bsdf.inputs:
        bsdf.inputs["Specular"].default_value = 0.0
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = 0.0
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])


def build_room() -> dict:
    log("Building geometry…")
    hw, hh, hd = ROOM_W * 0.5, ROOM_H * 0.5, ROOM_D * 0.5

    mat_floor = new_mat("Mat_Floor", color=FLOOR_RGB, roughness=0.025, metallic=0.12)
    mat_ceil = new_mat("Mat_Ceiling", color=BASE_RGB, roughness=0.35)
    mat_back = new_mat("Mat_WallBack", color=BASE_RGB, roughness=0.18)
    mat_front = new_mat("Mat_WallFront", color=BASE_RGB, roughness=0.22)
    mat_left = new_mat("Mat_WallLeft", color=BASE_RGB, roughness=0.2)
    mat_right = new_mat("Mat_WallRight", color=BASE_RGB, roughness=0.2)

    # Quads: corners ordered CCW when viewed along intended inward normal
    floor = make_quad(
        "Floor",
        [(-hw, -hd, 0), (hw, -hd, 0), (hw, hd, 0), (-hw, hd, 0)],
        mat_floor,
    )
    ceiling = make_quad(
        "Ceiling",
        [(-hw, -hd, ROOM_H), (-hw, hd, ROOM_H), (hw, hd, ROOM_H), (hw, -hd, ROOM_H)],
        mat_ceil,
    )
    wall_back = make_quad(
        "WallBack",
        [(-hw, -hd, 0), (-hw, -hd, ROOM_H), (hw, -hd, ROOM_H), (hw, -hd, 0)],
        mat_back,
    )
    wall_front = make_quad(
        "WallFront",
        [(hw, hd, 0), (hw, hd, ROOM_H), (-hw, hd, ROOM_H), (-hw, hd, 0)],
        mat_front,
    )
    wall_left = make_quad(
        "WallLeft",
        [(-hw, hd, 0), (-hw, hd, ROOM_H), (-hw, -hd, ROOM_H), (-hw, -hd, 0)],
        mat_left,
    )
    wall_right = make_quad(
        "WallRight",
        [(hw, -hd, 0), (hw, -hd, ROOM_H), (hw, hd, ROOM_H), (hw, hd, 0)],
        mat_right,
    )

    light_objs = []
    panel_w = ROOM_W * 0.78
    panel_d = 0.62
    panel_z = ROOM_H - 0.012
    # Reference: two long ceiling panels near the back wall
    for i, y in enumerate((-hd + 1.85, -hd + 2.85)):
        lm = new_mat(
            f"Mat_LightPanel_{i}",
            color=(1, 1, 1),
            roughness=0.4,
            emission=EMISSIVE_RGB,
            emission_strength=36.0,
        )
        light_objs.append(add_box(f"LightPanel_{i}", (panel_w, panel_d, 0.025), (0, y, panel_z), lm))

    # Subtle short coves near the lit end only
    cove_len = ROOM_D * 0.45
    for side, x in (("L", -hw + 0.03), ("R", hw - 0.03)):
        lm = new_mat(
            f"Mat_Cove_{side}",
            color=(1, 1, 1),
            roughness=0.5,
            emission=EMISSIVE_RGB,
            emission_strength=3.5,
        )
        light_objs.append(
            add_box(
                f"Cove_{side}",
                (0.04, cove_len, 0.03),
                (x, -hd + cove_len * 0.55, ROOM_H - 0.02),
                lm,
            )
        )

    def add_area(name, loc, size, energy):
        bpy.ops.object.light_add(type="AREA", location=loc, rotation=(math.pi, 0, 0))
        lit = bpy.context.active_object
        lit.name = name
        lit.data.energy = energy
        lit.data.color = (0.92, 0.98, 1.0)
        lit.data.shape = "RECTANGLE"
        lit.data.size = size[0]
        lit.data.size_y = size[1]
        return lit

    add_area("BakeArea_0", (0, -hd + 1.85, ROOM_H - 0.04), (panel_w, panel_d), 280)
    add_area("BakeArea_1", (0, -hd + 2.85, ROOM_H - 0.04), (panel_w, panel_d), 240)
    add_area("BakeFill", (0, -1.0, ROOM_H - 0.1), (ROOM_W * 0.9, ROOM_D * 0.55), 55)

    world = bpy.data.worlds.new("WorldCool") if "WorldCool" not in bpy.data.worlds else bpy.data.worlds["WorldCool"]
    bpy.context.scene.world = world
    world.use_nodes = True
    wn = world.node_tree.nodes
    wl = world.node_tree.links
    wn.clear()
    wout = wn.new("ShaderNodeOutputWorld")
    bg = wn.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (0.55, 0.72, 0.78, 1.0)
    bg.inputs["Strength"].default_value = 0.18
    wl.new(bg.outputs["Background"], wout.inputs["Surface"])

    bpy.ops.object.camera_add(location=(0, hd - 1.4, 1.55), rotation=(math.radians(88), 0, math.pi))
    cam = bpy.context.active_object
    cam.name = "PreviewCam"
    cam.data.lens = 22
    bpy.context.scene.camera = cam

    return {
        "bake_targets": [ceiling, wall_back, wall_left, wall_right, wall_front],
        "floor": floor,
        "lights": light_objs,
    }


def setup_cycles() -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    prefs = bpy.context.preferences.addons.get("cycles")
    if prefs:
        cprefs = prefs.preferences
        for compute in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
            try:
                cprefs.compute_device_type = compute
                for dev in cprefs.get_devices_for_type(compute):
                    dev.use = True
                scene.cycles.device = "GPU"
                log(f"Cycles device={compute} GPU")
                break
            except Exception:
                continue
    scene.cycles.samples = BAKE_SAMPLES
    scene.cycles.bake_type = "COMBINED"
    try:
        scene.cycles.use_denoising = True
    except Exception:
        pass
    scene.render.bake.margin = MARGIN
    scene.render.bake.use_clear = True
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
    scene.render.bake.use_pass_color = True
    scene.render.bake.use_pass_emit = True
    scene.render.bake.use_pass_diffuse = True
    scene.render.bake.use_pass_glossy = True


def tonemap_to_byte_image(src: bpy.types.Image, name: str, exposure: float) -> bpy.types.Image:
    """Convert HDR bake float buffer → display-range 8-bit sRGB image."""
    w, h = src.size
    src_px = list(src.pixels)  # RGBA float, length w*h*4
    # Auto-expose from 95th percentile of luminance so maps aren't black or clipped
    lum = []
    step = max(1, (len(src_px) // 4) // 20000) * 4
    for i in range(0, len(src_px), step):
        r, g, b = src_px[i], src_px[i + 1], src_px[i + 2]
        lum.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
    lum.sort()
    p95 = lum[int(len(lum) * 0.95)] if lum else 1.0
    scale = exposure
    if p95 > 1e-6:
        # Aim p95 ≈ 0.92 after tonemap input
        scale = (0.92 / p95) * exposure / 0.15
    log(f"  tonemap {name}: p95={p95:.4f} scale={scale:.4f}")

    out = [0.0] * len(src_px)
    for i in range(0, len(src_px), 4):
        for c in range(3):
            v = max(0.0, src_px[i + c] * scale)
            v = v / (1.0 + v * 0.28)
            # High-key clinical lift (reference is near-white with soft gradients)
            v = 0.48 + v * 0.55
            # Cool cyan tint
            if c == 0:
                v *= 0.97
            elif c == 2:
                v *= 1.02
            out[i + c] = max(0.0, min(1.0, v))
        out[i + 3] = 1.0

    if name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[name])
    dst = bpy.data.images.new(name, width=w, height=h, alpha=False, float_buffer=False)
    dst.colorspace_settings.name = "sRGB"
    dst.pixels = out
    dst.update()
    return dst


def bake_object(obj: bpy.types.Object) -> bpy.types.Image:
    BAKE_DIR.mkdir(parents=True, exist_ok=True)
    img_name = f"bake_{obj.name}"
    if img_name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[img_name])
    float_img = bpy.data.images.new(
        img_name + "_hdr", width=TEX_SIZE, height=TEX_SIZE, alpha=False, float_buffer=True
    )
    float_img.colorspace_settings.name = "Non-Color"
    mat = obj.data.materials[0]
    prepare_bake_target(mat, float_img)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    log(f"Baking Combined → {obj.name} ({TEX_SIZE}², {BAKE_SAMPLES} spp)…")
    bpy.ops.object.bake(type="COMBINED")

    byte_img = tonemap_to_byte_image(float_img, img_name, BAKE_EXPOSURE)
    # Point material bake node at byte image for later graph rebuild
    prepare_bake_target(mat, byte_img)

    png = BAKE_DIR / f"{obj.name}.png"
    byte_img.filepath_raw = str(png)
    byte_img.file_format = "PNG"
    byte_img.save()
    log(f"Saved {png}")
    bpy.data.images.remove(float_img)
    return byte_img


def render_room_equirect(scene_data: dict) -> None:
    """Bake a 360° equirect of THIS room (reflection probe) — not a stock HDRI.

    Captured at standing eye height with the floor hidden so the probe is walls /
    ceiling / emissive strips only (standard reflection-probe practice).
    """
    setup_cycles()
    scene = bpy.context.scene
    floor = scene_data["floor"]
    was_hide = floor.hide_render
    floor.hide_render = True

    cam_data = bpy.data.cameras.new("RoomEnvCam")
    cam_data.type = "PANO"
    cam_data.panorama_type = "EQUIRECTANGULAR"
    cam_data.clip_start = 0.05
    cam_data.clip_end = 80.0
    cam_obj = bpy.data.objects.new("RoomEnvCam", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    # Blender Z-up: probe center, eye height
    cam_obj.location = (0.0, 0.0, 1.55)
    cam_obj.rotation_euler = (math.pi / 2.0, 0.0, math.pi)  # look toward -Y (back / lights)
    scene.camera = cam_obj

    scene.render.resolution_x = 4096
    scene.render.resolution_y = 2048
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.filepath = str(ENV_PATH.with_suffix(""))  # Blender appends .png
    # Standard view transform so PNG isn't crushed by AgX
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = -0.35
    scene.view_settings.gamma = 1.0
    scene.cycles.samples = max(96, BAKE_SAMPLES)

    log(f"Rendering room equirect reflection probe → {ENV_PATH}")
    bpy.ops.render.render(write_still=True)

    # Blender may write room_env.png from filepath
    written = ENV_PATH if ENV_PATH.exists() else ENV_PATH.with_name(ENV_PATH.stem + "0001.png")
    if written.exists() and written != ENV_PATH:
        written.replace(ENV_PATH)
    if not ENV_PATH.exists():
        # Fallback: grab render result
        rr = bpy.data.images.get("Render Result")
        if rr:
            rr.filepath_raw = str(ENV_PATH)
            rr.file_format = "PNG"
            rr.save_render(str(ENV_PATH))
    log(f"Room env bytes={ENV_PATH.stat().st_size if ENV_PATH.exists() else 0}")

    floor.hide_render = was_hide
    # Keep camera in .blend for re-renders; hide from GLB export via type check


def run_bake(scene_data: dict) -> None:
    # 1) Room-specific reflection probe (glossy materials + live lights still active)
    render_room_equirect(scene_data)

    # 2) Combined lightmaps for walls / ceiling / floor albedo
    setup_cycles()
    for obj in scene_data["bake_targets"]:
        img = bake_object(obj)
        apply_baked_to_basecolor(obj.data.materials[0], img)

    floor = scene_data["floor"]
    floor_img = bake_object(floor)
    mat = floor.data.materials[0]
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = floor_img
    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    links.new(uv.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    # GLB: fully baked floor — NO metal/specular so glTF viewers do not attach a foreign IBL
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    elif "Specular" in bsdf.inputs:
        bsdf.inputs["Specular"].default_value = 0.0
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = 0.0
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    for lit in scene_data["lights"]:
        m = lit.data.materials[0]
        bsdf = find_principled(m)
        if bsdf and "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = 22.0


def export_glb() -> None:
    for obj in bpy.data.objects:
        if obj.type == "LIGHT" or obj.type == "CAMERA":
            obj.hide_set(True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.data.objects:
        if obj.type == "MESH":
            obj.hide_set(False)
            obj.select_set(True)
    log(f"Exporting GLB → {GLB_PATH}")
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_yup=True,
    )
    log(f"GLB bytes={GLB_PATH.stat().st_size if GLB_PATH.exists() else 0}")


def save_blend() -> None:
    for obj in bpy.data.objects:
        obj.hide_set(False)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    log(f"Saved blend → {BLEND_PATH}")


def main() -> None:
    log(f"Blender {bpy.app.version_string} | TEX={TEX_SIZE} spp={BAKE_SAMPLES} quick={QUICK}")
    clear_scene()
    scene_data = build_room()
    if not QUICK:
        run_bake(scene_data)
    else:
        log("QUICK mode: skipping Cycles bake")
    export_glb()
    save_blend()
    log("DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
