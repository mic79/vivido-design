#!/usr/bin/env python3
"""
Build skirmish Moon_0 from Beyond All Reason 'Hera Planum' maps:
  height + dry diffuse + detail normal
  https://www.beyondallreason.info/map/hera-planum

  WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 python RTSVR6/scripts/build-hera-planum.py
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys

from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
HERA = os.path.join(ROOT, "assets", "mesa", "hera-planum")
LIVE = os.path.join(ROOT, "assets", "terrain", "terrain-skirmish-1v1.glb")
BASE = LIVE + ".pre-mesa.bak" if os.path.isfile(LIVE + ".pre-mesa.bak") else LIVE
HM = os.path.join(HERA, "height.png")
DIFF_HQ = os.path.join(HERA, "diffuse-hq.jpg")
DIFF_SRC = os.path.join(HERA, "diffuse.png")
DIFF_FALLBACK = os.path.join(HERA, "diffuse-2k.jpg")
NORM_HQ = os.path.join(HERA, "normal-hq.jpg")
NORM_DETAIL_SRC = os.path.join(HERA, "normal.png")
DIFF = os.path.join(HERA, "diffuse-bake.jpg")
NORM = os.path.join(HERA, "normal-bake.jpg")
WRITE_LIVE = os.environ.get("WRITE_LIVE") == "1" and os.environ.get("CONFIRM_WRITE_LIVE") == "1"

# Visual plate only — gameplay spawns/nav stay on MAP_SIZE_STANDARD=200.
HALF_X = float(os.environ.get("HALF_X", "1000"))
HALF_Z = float(os.environ.get("HALF_Z", "1000"))
RES = int(os.environ.get("RES", "512"))
H_SCALE = float(os.environ.get("H_SCALE", "56"))
Y_OFFSET = float(os.environ.get("Y_OFFSET", "-25"))
# Prefer full native HQ extract (10240). Fallback lower maps if present.
TEX_MAX = int(os.environ.get("TEX_MAX", "10240"))


def prepare_textures(_hm=None):
    """Prefer diffuse-hq.jpg / normal-hq.jpg. No retints."""
    if os.path.isfile(DIFF_HQ):
        diff = Image.open(DIFF_HQ).convert("RGB")
        print("using diffuse-hq.jpg")
    elif os.path.isfile(DIFF_SRC):
        diff = Image.open(DIFF_SRC).convert("RGB")
        print("using diffuse.png (4K web)")
    elif os.path.isfile(DIFF_FALLBACK):
        diff = Image.open(DIFF_FALLBACK).convert("RGB")
        print("using diffuse-2k.jpg")
    else:
        raise SystemExit("missing diffuse — run extract-hera-hq-textures.py")
    diff.thumbnail((TEX_MAX, TEX_MAX), Image.Resampling.LANCZOS)
    diff.save(DIFF, "JPEG", quality=92, optimize=True, progressive=True)
    print("diffuse bake", diff.size, os.path.getsize(DIFF))

    if os.path.isfile(NORM_HQ):
        nrm = Image.open(NORM_HQ).convert("RGB")
        print("using normal-hq.jpg")
    elif os.path.isfile(NORM_DETAIL_SRC):
        nrm = Image.open(NORM_DETAIL_SRC).convert("RGB")
        print("using normal.png (web)")
    else:
        raise SystemExit("missing normal — run extract-hera-hq-textures.py")
    nrm.thumbnail((TEX_MAX, TEX_MAX), Image.Resampling.LANCZOS)
    nrm.save(NORM, "JPEG", quality=92, optimize=True, progressive=True)
    print("normal bake", nrm.size, os.path.getsize(NORM))


def align4(n):
    return (4 - (n % 4)) % 4


def sample_lum(im, u, v):
    w, h = im.size
    x = min(w - 1, max(0, u * (w - 1)))
    y = min(h - 1, max(0, (1.0 - v) * (h - 1)))
    x0, y0 = int(x), int(y)
    x1, y1 = min(w - 1, x0 + 1), min(h - 1, y0 + 1)
    fx, fy = x - x0, y - y0
    p = im.load()

    def L(ix, iy):
        c = p[ix, iy]
        return c[0] / 255.0

    a = L(x0, y0) * (1 - fx) + L(x1, y0) * fx
    b = L(x0, y1) * (1 - fx) + L(x1, y1) * fx
    return a * (1 - fy) + b * fy


def build_mesh(hm):
    n = RES
    lum_min, lum_max = 1.0, 0.0
    for iz in range(n):
        for ix in range(n):
            u = ix / (n - 1)
            v = iz / (n - 1)
            lum = sample_lum(hm, u, v)
            lum_min = min(lum_min, lum)
            lum_max = max(lum_max, lum)
    span = max(1e-4, lum_max - lum_min)
    print("luminance", round(lum_min, 3), round(lum_max, 3))

    verts = []
    uvs = []
    h_min, h_max = 1e9, -1e9
    for iz in range(n):
        for ix in range(n):
            u = ix / (n - 1)
            v = iz / (n - 1)
            x = -HALF_X + u * HALF_X * 2
            z = -HALF_Z + v * HALF_Z * 2
            lum = sample_lum(hm, u, v)
            h = ((lum - lum_min) / span) * H_SCALE + Y_OFFSET
            # Keep natural Hera slopes to the plate edge — do NOT zero a circular rim
            # (that caused the harsh vertical drop-off).
            verts.extend((x, h, z))
            uvs.extend((u, v))  # 0..1 for diffuse/normal
            h_min = min(h_min, h)
            h_max = max(h_max, h)

    indices = []
    for iz in range(n - 1):
        for ix in range(n - 1):
            i0 = iz * n + ix
            i1 = i0 + 1
            i2 = i0 + n
            i3 = i2 + 1
            indices.extend((i0, i2, i1, i1, i2, i3))

    normals = [0.0] * (n * n * 3)

    def add_n(i, nx, ny, nz):
        normals[i * 3] += nx
        normals[i * 3 + 1] += ny
        normals[i * 3 + 2] += nz

    for t in range(0, len(indices), 3):
        a, b, c = indices[t], indices[t + 1], indices[t + 2]
        ax, ay, az = verts[a * 3 : a * 3 + 3]
        bx, by, bz = verts[b * 3 : b * 3 + 3]
        cx, cy, cz = verts[c * 3 : c * 3 + 3]
        e1x, e1y, e1z = bx - ax, by - ay, bz - az
        e2x, e2y, e2z = cx - ax, cy - ay, cz - az
        nx = e1y * e2z - e1z * e2y
        ny = e1z * e2x - e1x * e2z
        nz = e1x * e2y - e1y * e2x
        add_n(a, nx, ny, nz)
        add_n(b, nx, ny, nz)
        add_n(c, nx, ny, nz)

    for i in range(n * n):
        nx, ny, nz = normals[i * 3 : i * 3 + 3]
        L = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        normals[i * 3] = nx / L
        normals[i * 3 + 1] = ny / L
        normals[i * 3 + 2] = nz / L

    return verts, normals, uvs, indices, h_min, h_max


def write_plate_glb(path, verts, normals, uvs, indices, diff_bytes, norm_bytes):
    blobs = []
    views = []
    accessors = []

    def add_blob(data, target=None):
        pad = align4(len(data))
        off = sum(len(b) for b in blobs)
        blobs.append(data + (b"\x00" * pad))
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target is not None:
            bv["target"] = target
        views.append(bv)
        return len(views) - 1

    v_bytes = struct.pack("<%df" % len(verts), *verts)
    n_bytes = struct.pack("<%df" % len(normals), *normals)
    uv_bytes = struct.pack("<%df" % len(uvs), *uvs)
    i_bytes = struct.pack("<%dI" % len(indices), *indices)

    vc = len(verts) // 3
    vmin = [min(verts[i::3]) for i in range(3)]
    vmax = [max(verts[i::3]) for i in range(3)]

    bv_v = add_blob(v_bytes, 34962)
    bv_n = add_blob(n_bytes, 34962)
    bv_uv = add_blob(uv_bytes, 34962)
    bv_i = add_blob(i_bytes, 34963)
    bv_diff = add_blob(diff_bytes)
    bv_norm = add_blob(norm_bytes)

    accessors = [
        {
            "bufferView": bv_v,
            "componentType": 5126,
            "count": vc,
            "type": "VEC3",
            "max": vmax,
            "min": vmin,
        },
        {"bufferView": bv_n, "componentType": 5126, "count": vc, "type": "VEC3"},
        {"bufferView": bv_uv, "componentType": 5126, "count": vc, "type": "VEC2"},
        {
            "bufferView": bv_i,
            "componentType": 5125,
            "count": len(indices),
            "type": "SCALAR",
            "max": [max(indices)],
            "min": [0],
        },
    ]

    images = [
        {"mimeType": "image/jpeg", "bufferView": bv_diff},
        {"mimeType": "image/jpeg", "bufferView": bv_norm},
    ]
    samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
    textures = [
        {"sampler": 0, "source": 0},
        {"sampler": 0, "source": 1},
    ]
    materials = [
        {
            "name": "M_HeraPlanum",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "baseColorFactor": [1, 1, 1, 1],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.92,
            },
            "normalTexture": {"index": 1, "scale": 1.0},
        }
    ]
    meshes = [
        {
            "name": "Moon_0",
            "primitives": [
                {
                    "attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2},
                    "indices": 3,
                    "material": 0,
                    "mode": 4,
                }
            ],
        }
    ]
    bin_blob = b"".join(blobs)
    doc = {
        "asset": {"version": "2.0", "generator": "build-hera-planum.py"},
        "scenes": [{"nodes": [0]}],
        "scene": 0,
        "nodes": [{"name": "Moon_0", "mesh": 0}],
        "meshes": meshes,
        "materials": materials,
        "textures": textures,
        "samplers": samplers,
        "images": images,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(bin_blob)}],
        "extras": {
            "rtsMesaHeightfield": {
                "method": "hera-planum-bar",
                "halfX": HALF_X,
                "halfZ": HALF_Z,
                "res": RES,
                "hScale": H_SCALE,
                "yOffset": Y_OFFSET,
                "source": "beyondallreason.info/map/hera-planum",
            }
        },
    }
    jb = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    jb = jb + (b" " * align4(len(jb)))
    bp = align4(len(bin_blob))
    bin_pad = bin_blob + (b"\x00" * bp)
    total = 12 + 8 + len(jb) + 8 + len(bin_pad)
    out = bytearray(total)
    struct.pack_into("<4sII", out, 0, b"glTF", 2, total)
    struct.pack_into("<I4s", out, 12, len(jb), b"JSON")
    out[20 : 20 + len(jb)] = jb
    o = 20 + len(jb)
    struct.pack_into("<I4s", out, o, len(bin_pad), b"BIN\x00")
    out[o + 8 : o + 8 + len(bin_pad)] = bin_pad
    with open(path, "wb") as f:
        f.write(out)
    return len(out)


def parse_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    jlen = struct.unpack_from("<I", data, 12)[0]
    raw = data[20 : 20 + jlen].decode("utf-8").rstrip(" \x00")
    raw = raw.replace(":inf", ":null").replace(":-inf", ":null")
    doc = json.loads(raw)
    bin_off = 20 + jlen
    blen = struct.unpack_from("<I", data, bin_off)[0]
    braw = bytearray(data[bin_off + 8 : bin_off + 8 + blen])
    return doc, braw


def write_glb(path, doc, braw):
    braw = bytearray(braw)
    bp = align4(len(braw))
    if bp:
        braw.extend(b"\x00" * bp)
    doc["buffers"] = [{"byteLength": len(braw)}]
    jb = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    jb = jb + (b" " * align4(len(jb)))
    total = 12 + 8 + len(jb) + 8 + len(braw)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(jb), b"JSON"))
        f.write(jb)
        f.write(struct.pack("<I4s", len(braw), b"BIN\x00"))
        f.write(braw)


def write_live_clean(plate_path, h_min, h_max):
    """Ship Moon_0-only Hera plate — never merge into the old crater+props GLB."""
    plate_doc, plate_bin = parse_glb(plate_path)
    plate_doc.setdefault("extras", {})
    plate_doc["extras"]["rtsMesaHeightfield"] = {
        "method": "hera-planum-bar",
        "halfX": HALF_X,
        "halfZ": HALF_Z,
        "res": RES,
        "hMin": h_min,
        "hMax": h_max,
        "hScale": H_SCALE,
        "yOffset": Y_OFFSET,
        "source": "https://www.beyondallreason.info/map/hera-planum",
        "hasDiffuse": True,
        "hasNormal": True,
        "texMax": TEX_MAX,
    }
    out = LIVE if WRITE_LIVE else os.path.join(HERA, "terrain-hera-planum.glb")
    if WRITE_LIVE and os.path.isfile(LIVE) and not os.path.isfile(LIVE + ".pre-hera-clean.bak"):
        open(LIVE + ".pre-hera-clean.bak", "wb").write(open(LIVE, "rb").read())
    write_glb(out, plate_doc, plate_bin)
    print("wrote", out, os.path.getsize(out), "half", HALF_X, "meshes", len(plate_doc.get("meshes") or []))
    if not WRITE_LIVE:
        print("Dry-run — WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1")


def merge_into_live(plate_path, h_min, h_max):
    # Kept for reference; live ship path is write_live_clean (no leftover UE meshes).
    write_live_clean(plate_path, h_min, h_max)


def main():
    if not os.path.isfile(HM):
        print("missing", HM)
        sys.exit(1)
    hm = Image.open(HM).convert("RGB")
    prepare_textures(hm)
    if not os.path.isfile(DIFF) or not os.path.isfile(NORM):
        print("texture prepare failed")
        sys.exit(1)
    print("building Hera Planum RES", RES, "size", HALF_X * 2, "x", HALF_Z * 2, "H", H_SCALE, "Y", Y_OFFSET)
    verts, normals, uvs, indices, h_min, h_max = build_mesh(hm)
    print("height", round(h_min, 3), round(h_max, 3), "tris", len(indices) // 3)
    plate = os.path.join(HERA, "skirmish-hera-planum.glb")
    write_plate_glb(
        plate,
        verts,
        normals,
        uvs,
        indices,
        open(DIFF, "rb").read(),
        open(NORM, "rb").read(),
    )
    print("wrote", plate, os.path.getsize(plate))
    merge_into_live(plate, h_min, h_max)


if __name__ == "__main__":
    main()
