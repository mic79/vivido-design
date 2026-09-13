#!/usr/bin/env python3
"""
Build skirmish Hera Planum plate for RTSVR6:
  - Dense heightfield (default RES=768) over ±HALF (±1000 m)
  - Split into CELLS×CELLS meshes sharing ONE material + ONE texture pair
    (frustum cull works; no per-cell texture duplication)
  - Runtime still swaps diffuse-hq / normal-hq (+ splat DNTS)

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
HM = os.path.join(HERA, "height.png")
DIFF_HQ = os.path.join(HERA, "diffuse-hq.jpg")
DIFF_SRC = os.path.join(HERA, "diffuse.png")
DIFF_FALLBACK = os.path.join(HERA, "diffuse-2k.jpg")
NORM_HQ = os.path.join(HERA, "normal-hq.jpg")
NORM_DETAIL_SRC = os.path.join(HERA, "normal.png")
DIFF = os.path.join(HERA, "diffuse-bake.jpg")
NORM = os.path.join(HERA, "normal-bake.jpg")
WRITE_LIVE = os.environ.get("WRITE_LIVE") == "1" and os.environ.get("CONFIRM_WRITE_LIVE") == "1"

HALF_X = float(os.environ.get("HALF_X", "1000"))
HALF_Z = float(os.environ.get("HALF_Z", "1000"))
# Denser than 512 — frustum-culled cells keep per-view cost in check.
RES = int(os.environ.get("RES", "768"))
CELLS = int(os.environ.get("CELLS", "8"))
H_SCALE = float(os.environ.get("H_SCALE", "56"))
Y_OFFSET = float(os.environ.get("Y_OFFSET", "-25"))
# Embed mid-res in GLB (boot); runtime applyMesaHqTextures loads full native HQ.
TEX_MAX = int(os.environ.get("TEX_MAX", "4096"))


def prepare_textures(_hm=None):
    """Prefer diffuse-hq.jpg / normal-hq.jpg. No retints."""
    if os.path.isfile(DIFF_HQ):
        diff = Image.open(DIFF_HQ).convert("RGB")
        print("using diffuse-hq.jpg")
    elif os.path.isfile(DIFF_SRC):
        diff = Image.open(DIFF_SRC).convert("RGB")
        print("using diffuse.png")
    elif os.path.isfile(DIFF_FALLBACK):
        diff = Image.open(DIFF_FALLBACK).convert("RGB")
        print("using diffuse-2k.jpg")
    else:
        raise SystemExit("missing diffuse — run extract-hera-hq-textures.py")
    diff.thumbnail((TEX_MAX, TEX_MAX), Image.Resampling.LANCZOS)
    diff.save(DIFF, "JPEG", quality=90, optimize=True, progressive=True)
    print("diffuse bake", diff.size, os.path.getsize(DIFF))

    if os.path.isfile(NORM_HQ):
        nrm = Image.open(NORM_HQ).convert("RGB")
        print("using normal-hq.jpg")
    elif os.path.isfile(NORM_DETAIL_SRC):
        nrm = Image.open(NORM_DETAIL_SRC).convert("RGB")
        print("using normal.png")
    else:
        raise SystemExit("missing normal — run extract-hera-hq-textures.py")
    nrm.thumbnail((TEX_MAX, TEX_MAX), Image.Resampling.LANCZOS)
    nrm.save(NORM, "JPEG", quality=90, optimize=True, progressive=True)
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


def build_height_grid(hm):
    n = RES
    lum_min, lum_max = 1.0, 0.0
    for iz in range(n):
        for ix in range(n):
            lum = sample_lum(hm, ix / (n - 1), iz / (n - 1))
            lum_min = min(lum_min, lum)
            lum_max = max(lum_max, lum)
    span = max(1e-4, lum_max - lum_min)
    print("luminance", round(lum_min, 3), round(lum_max, 3))

    heights = [0.0] * (n * n)
    h_min, h_max = 1e9, -1e9
    for iz in range(n):
        for ix in range(n):
            lum = sample_lum(hm, ix / (n - 1), iz / (n - 1))
            h = ((lum - lum_min) / span) * H_SCALE + Y_OFFSET
            heights[iz * n + ix] = h
            h_min = min(h_min, h)
            h_max = max(h_max, h)
    return heights, h_min, h_max


def extract_cell(heights, ci, cj):
    """Inclusive grid patch for cell (ci,cj); shared edges with neighbors (no cracks)."""
    n = RES
    # Vertex ranges: n verts → CELLS segments of (n-1)/CELLS quads.
    step = (n - 1) / CELLS
    ix0 = int(round(ci * step))
    ix1 = int(round((ci + 1) * step))
    iz0 = int(round(cj * step))
    iz1 = int(round((cj + 1) * step))
    ix0 = max(0, min(n - 1, ix0))
    ix1 = max(ix0 + 1, min(n - 1, ix1))
    iz0 = max(0, min(n - 1, iz0))
    iz1 = max(iz0 + 1, min(n - 1, iz1))
    nw = ix1 - ix0 + 1
    nh = iz1 - iz0 + 1

    verts = []
    uvs = []
    for jz in range(nh):
        iz = iz0 + jz
        v = iz / (n - 1)
        z = -HALF_Z + v * HALF_Z * 2
        for jx in range(nw):
            ix = ix0 + jx
            u = ix / (n - 1)
            x = -HALF_X + u * HALF_X * 2
            h = heights[iz * n + ix]
            verts.extend((x, h, z))
            uvs.extend((u, v))

    indices = []
    for jz in range(nh - 1):
        for jx in range(nw - 1):
            i0 = jz * nw + jx
            i1 = i0 + 1
            i2 = i0 + nw
            i3 = i2 + 1
            indices.extend((i0, i2, i1, i1, i2, i3))

    normals = [0.0] * (nw * nh * 3)

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

    for i in range(nw * nh):
        nx, ny, nz = normals[i * 3 : i * 3 + 3]
        L = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        normals[i * 3] = nx / L
        normals[i * 3 + 1] = ny / L
        normals[i * 3 + 2] = nz / L

    return verts, normals, uvs, indices, (ix0, ix1, iz0, iz1)


def write_plate_glb(path, cells, diff_bytes, norm_bytes, h_min, h_max):
    """cells: list of (name, verts, normals, uvs, indices). Shared material 0."""
    blobs = []
    views = []

    def add_blob(data, target=None):
        pad = align4(len(data))
        off = sum(len(b) for b in blobs)
        blobs.append(data + (b"\x00" * pad))
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target is not None:
            bv["target"] = target
        views.append(bv)
        return len(views) - 1

    bv_diff = add_blob(diff_bytes)
    bv_norm = add_blob(norm_bytes)
    accessors = []
    meshes = []
    cell_nodes = []

    for name, verts, normals, uvs, indices in cells:
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
        ai = len(accessors)
        accessors.extend(
            [
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
        )
        mi = len(meshes)
        meshes.append(
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": ai,
                            "NORMAL": ai + 1,
                            "TEXCOORD_0": ai + 2,
                        },
                        "indices": ai + 3,
                        "material": 0,
                        "mode": 4,
                    }
                ],
            }
        )
        cell_nodes.append({"name": name, "mesh": mi})

    # Root Moon_0 groups cells — frustum culls per child; height/HQ match /^Moon_0/.
    nodes = [{"name": "Moon_0", "children": list(range(1, 1 + len(cell_nodes)))}] + cell_nodes

    images = [
        {"mimeType": "image/jpeg", "bufferView": bv_diff},
        {"mimeType": "image/jpeg", "bufferView": bv_norm},
    ]
    samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
    textures = [{"sampler": 0, "source": 0}, {"sampler": 0, "source": 1}]
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
    bin_blob = b"".join(blobs)
    doc = {
        "asset": {"version": "2.0", "generator": "build-hera-planum.py"},
        "scenes": [{"nodes": [0]}],
        "scene": 0,
        "nodes": nodes,
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
                "method": "hera-planum-bar-cells",
                "halfX": HALF_X,
                "halfZ": HALF_Z,
                "res": RES,
                "cells": CELLS,
                "hMin": h_min,
                "hMax": h_max,
                "hScale": H_SCALE,
                "yOffset": Y_OFFSET,
                "source": "https://www.beyondallreason.info/map/hera-planum",
                "hasDiffuse": True,
                "hasNormal": True,
                "texMax": TEX_MAX,
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
    plate_doc, plate_bin = parse_glb(plate_path)
    out = LIVE if WRITE_LIVE else os.path.join(HERA, "terrain-hera-planum.glb")
    write_glb(out, plate_doc, plate_bin)
    print(
        "wrote",
        out,
        os.path.getsize(out),
        "half",
        HALF_X,
        "meshes",
        len(plate_doc.get("meshes") or []),
        "cells",
        CELLS,
    )
    if not WRITE_LIVE:
        print("Dry-run — WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1")


def main():
    if CELLS < 1 or CELLS > 32:
        raise SystemExit("CELLS must be 1..32")
    if not os.path.isfile(HM):
        print("missing", HM)
        sys.exit(1)
    hm = Image.open(HM).convert("RGB")
    prepare_textures(hm)
    print(
        "building Hera Planum RES",
        RES,
        "CELLS",
        CELLS,
        "size",
        HALF_X * 2,
        "x",
        HALF_Z * 2,
    )
    heights, h_min, h_max = build_height_grid(hm)
    cells = []
    total_tris = 0
    for cj in range(CELLS):
        for ci in range(CELLS):
            name = f"Moon_0_{ci}_{cj}"
            verts, normals, uvs, indices, _bb = extract_cell(heights, ci, cj)
            total_tris += len(indices) // 3
            cells.append((name, verts, normals, uvs, indices))
    print("height", round(h_min, 3), round(h_max, 3), "tris", total_tris, "cellMeshes", len(cells))
    plate = os.path.join(HERA, "skirmish-hera-planum.glb")
    write_plate_glb(
        plate,
        cells,
        open(DIFF, "rb").read(),
        open(NORM, "rb").read(),
        h_min,
        h_max,
    )
    print("wrote", plate, os.path.getsize(plate))
    write_live_clean(plate, h_min, h_max)


if __name__ == "__main__":
    main()
