#!/usr/bin/env python3
"""Build Moon_0 plate from user heightmap + color top-down. Pure Python (PIL)."""
from __future__ import annotations

import json
import math
import os
import struct
import sys

from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
MESA = os.path.join(ROOT, "assets", "mesa")
LIVE = os.path.join(ROOT, "assets", "terrain", "terrain-skirmish-1v1.glb")
BASE = LIVE + ".pre-mesa.bak" if os.path.isfile(LIVE + ".pre-mesa.bak") else LIVE
HM = os.path.join(MESA, "ref-heightmap.png")
COL = os.path.join(MESA, "ref-topdown.jpg")
WRITE_LIVE = os.environ.get("WRITE_LIVE") == "1" and os.environ.get("CONFIRM_WRITE_LIVE") == "1"
HALF = 100.0
RES = int(os.environ.get("RES", "384"))
H_SCALE = float(os.environ.get("H_SCALE", "16"))


def sample_rgba(im, u, v):
    """u,v in 0..1, v=0 is south (-Z). Returns (r,g,b,a) 0..1."""
    w, h = im.size
    x = min(w - 1, max(0, u * (w - 1)))
    y = min(h - 1, max(0, (1.0 - v) * (h - 1)))
    x0, y0 = int(x), int(y)
    x1, y1 = min(w - 1, x0 + 1), min(h - 1, y0 + 1)
    fx, fy = x - x0, y - y0
    p = im.load()

    def px(ix, iy):
        c = p[ix, iy]
        if len(c) == 3:
            return c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, 1.0
        return c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, c[3] / 255.0

    a = px(x0, y0)
    b = px(x1, y0)
    c = px(x0, y1)
    d = px(x1, y1)
    out = []
    for i in range(4):
        top = a[i] * (1 - fx) + b[i] * fx
        bot = c[i] * (1 - fx) + d[i] * fx
        out.append(top * (1 - fy) + bot * fy)
    return out


def build_mesh():
    hm = Image.open(HM).convert("RGB")
    col = Image.open(COL).convert("RGB")
    n = RES
    # Pass 1: find luminance range so dark→0 and light→H_SCALE (full relief)
    lum_min, lum_max = 1.0, 0.0
    for iz in range(0, n, max(1, n // 64)):
        for ix in range(0, n, max(1, n // 64)):
            u = ix / (n - 1)
            v = iz / (n - 1)
            lum = sample_rgba(hm, u, v)[0]
            lum_min = min(lum_min, lum)
            lum_max = max(lum_max, lum)
    # denser scan
    for iz in range(n):
        for ix in range(n):
            u = ix / (n - 1)
            v = iz / (n - 1)
            lum = sample_rgba(hm, u, v)[0]
            lum_min = min(lum_min, lum)
            lum_max = max(lum_max, lum)
    span = max(1e-4, lum_max - lum_min)
    print("luminance", round(lum_min, 3), round(lum_max, 3))

    verts = []
    uvs = []
    colors = []
    h_min, h_max = 1e9, -1e9
    for iz in range(n):
        for ix in range(n):
            u = ix / (n - 1)
            v = iz / (n - 1)
            x = -HALF + u * HALF * 2
            z = -HALF + v * HALF * 2
            lum = sample_rgba(hm, u, v)[0]
            h = ((lum - lum_min) / span) * H_SCALE
            rd = math.hypot(x, z)
            if rd > HALF * 0.98:
                h = 0.0
            verts.extend((x, h, z))
            uvs.extend((u * 4.0, v * 4.0))
            h_min = min(h_min, h)
            h_max = max(h_max, h)
            cr, cg, cb, _ = sample_rgba(col, u, v)
            colors.extend((cr, cg, cb))

    # indices
    indices = []
    for iz in range(n - 1):
        for ix in range(n - 1):
            i0 = iz * n + ix
            i1 = i0 + 1
            i2 = i0 + n
            i3 = i2 + 1
            indices.extend((i0, i2, i1, i1, i2, i3))

    # normals from faces
    normals = [0.0] * (n * n * 3)

    def add_n(i, nx, ny, nz):
        normals[i * 3] += nx
        normals[i * 3 + 1] += ny
        normals[i * 3 + 2] += nz

    for t in range(0, len(indices), 3):
        a, b, c = indices[t], indices[t + 1], indices[t + 2]
        ax, ay, az = verts[a * 3], verts[a * 3 + 1], verts[a * 3 + 2]
        bx, by, bz = verts[b * 3], verts[b * 3 + 1], verts[b * 3 + 2]
        cx, cy, cz = verts[c * 3], verts[c * 3 + 1], verts[c * 3 + 2]
        e1x, e1y, e1z = bx - ax, by - ay, bz - az
        e2x, e2y, e2z = cx - ax, cy - ay, cz - az
        nx = e1y * e2z - e1z * e2y
        ny = e1z * e2x - e1x * e2z
        nz = e1x * e2y - e1y * e2x
        add_n(a, nx, ny, nz)
        add_n(b, nx, ny, nz)
        add_n(c, nx, ny, nz)

    for i in range(n * n):
        nx, ny, nz = normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]
        L = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        normals[i * 3] = nx / L
        normals[i * 3 + 1] = ny / L
        normals[i * 3 + 2] = nz / L
        # slope tint: steep → darker rocky
        ny_abs = abs(normals[i * 3 + 1])
        slope = 1.0 - ny_abs
        steep = max(0.0, min(1.0, (slope - 0.15) / 0.5))
        cr, cg, cb = colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]
        # cliff dark brown
        cliff = (0.35, 0.25, 0.19)
        cr = cr * (1 - steep * 0.55) + cliff[0] * steep * 0.55
        cg = cg * (1 - steep * 0.55) + cliff[1] * steep * 0.55
        cb = cb * (1 - steep * 0.55) + cliff[2] * steep * 0.55
        rd = math.hypot(verts[i * 3], verts[i * 3 + 2])
        if rd > HALF * 0.98:
            cr = cg = cb = 0.02
        colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2] = cr, cg, cb

    return verts, normals, uvs, colors, indices, h_min, h_max


def align4(n):
    return (4 - (n % 4)) % 4


def write_plate_glb(path, verts, normals, uvs, colors, indices):
    # pack binary blobs
    v_bytes = struct.pack("<%df" % len(verts), *verts)
    n_bytes = struct.pack("<%df" % len(normals), *normals)
    uv_bytes = struct.pack("<%df" % len(uvs), *uvs)
    c_bytes = struct.pack("<%df" % len(colors), *colors)
    # indices uint32
    i_bytes = struct.pack("<%dI" % len(indices), *indices)

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

    vc = len(verts) // 3
    vmin = [min(verts[i::3]) for i in range(3)]
    vmax = [max(verts[i::3]) for i in range(3)]

    bv_v = add_blob(v_bytes, 34962)
    bv_n = add_blob(n_bytes, 34962)
    bv_uv = add_blob(uv_bytes, 34962)
    bv_c = add_blob(c_bytes, 34962)
    bv_i = add_blob(i_bytes, 34963)

    accessors.append(
        {
            "bufferView": bv_v,
            "componentType": 5126,
            "count": vc,
            "type": "VEC3",
            "max": vmax,
            "min": vmin,
        }
    )
    accessors.append(
        {"bufferView": bv_n, "componentType": 5126, "count": vc, "type": "VEC3"}
    )
    accessors.append(
        {"bufferView": bv_uv, "componentType": 5126, "count": vc, "type": "VEC2"}
    )
    accessors.append(
        {"bufferView": bv_c, "componentType": 5126, "count": vc, "type": "VEC3"}
    )
    accessors.append(
        {
            "bufferView": bv_i,
            "componentType": 5125,
            "count": len(indices),
            "type": "SCALAR",
            "max": [max(indices)],
            "min": [0],
        }
    )

    bin_blob = b"".join(blobs)
    doc = {
        "asset": {"version": "2.0", "generator": "build-from-heightmap.py"},
        "scenes": [{"nodes": [0]}],
        "scene": 0,
        "nodes": [{"name": "Moon_0", "mesh": 0}],
        "meshes": [
            {
                "name": "Moon_0",
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": 0,
                            "NORMAL": 1,
                            "TEXCOORD_0": 2,
                            "COLOR_0": 3,
                        },
                        "indices": 4,
                        "material": 0,
                        "mode": 4,
                    }
                ],
            }
        ],
        "materials": [
            {
                "name": "M_HeightmapTerrain",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [1, 1, 1, 1],
                    "metallicFactor": 0.02,
                    "roughnessFactor": 0.92,
                },
                "extras": {"vertexColors": True},
            }
        ],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(bin_blob)}],
    }
    # Force vertex colors via KHR? Three/GLTFLoader enables COLOR_0 automatically.
    jb = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    jp = align4(len(jb))
    jb = jb + (b" " * jp)
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
    jp = align4(len(jb))
    jb = jb + (b" " * jp)
    total = 12 + 8 + len(jb) + 8 + len(braw)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(jb), b"JSON"))
        f.write(jb)
        f.write(struct.pack("<I4s", len(braw), b"BIN\x00"))
        f.write(braw)


def merge_into_live(plate_path):
    live_doc, live_bin = parse_glb(BASE)
    plate_doc, plate_bin = parse_glb(plate_path)

    # strip props + extra moons
    drop = set()
    for i, n in enumerate(live_doc.get("nodes") or []):
        name = n.get("name") or ""
        if name.startswith("Prop_") or (
            name.startswith("Moon_") and name != "Moon_0"
        ):
            drop.add(i)
        if name.startswith("SM_Rock") or name.startswith("SM_Cliff"):
            drop.add(i)
    if drop:
        keep = []
        mapping = {}
        for i, n in enumerate(live_doc["nodes"]):
            if i in drop:
                continue
            mapping[i] = len(keep)
            keep.append(n)
        live_doc["nodes"] = keep
        sc = live_doc["scenes"][live_doc.get("scene", 0)]
        sc["nodes"] = [mapping[i] for i in sc.get("nodes") or [] if i in mapping]
        for n in live_doc["nodes"]:
            if "children" in n:
                n["children"] = [mapping[c] for c in n["children"] if c in mapping]
        print("stripped", len(drop))

    def append(key, arr):
        live_doc.setdefault(key, [])
        base = len(live_doc[key])
        for item in arr or []:
            live_doc[key].append(json.loads(json.dumps(item)))
        return base

    bv0 = append("bufferViews", plate_doc.get("bufferViews"))
    acc0 = append("accessors", plate_doc.get("accessors"))
    mat0 = append("materials", plate_doc.get("materials"))
    mesh0 = append("meshes", plate_doc.get("meshes"))

    pad = align4(len(live_bin))
    start = len(live_bin) + pad
    new_bin = bytearray(live_bin) + bytearray(pad) + bytearray(plate_bin)

    for i in range(bv0, len(live_doc["bufferViews"])):
        bv = live_doc["bufferViews"][i]
        bv["buffer"] = 0
        bv["byteOffset"] = bv.get("byteOffset", 0) + start
    for i in range(acc0, len(live_doc["accessors"])):
        a = live_doc["accessors"][i]
        if "bufferView" in a:
            a["bufferView"] += bv0
    for i in range(mesh0, len(live_doc["meshes"])):
        for prim in live_doc["meshes"][i].get("primitives") or []:
            if "indices" in prim:
                prim["indices"] += acc0
            if "material" in prim:
                prim["material"] += mat0
            attrs = prim.get("attributes") or {}
            for k in attrs:
                attrs[k] += acc0

    moon = None
    for n in live_doc["nodes"]:
        if (n.get("name") or "") == "Moon_0":
            moon = n
            break
    if moon is None:
        moon = {"name": "Moon_0"}
        live_doc["nodes"].append(moon)
        live_doc["scenes"][live_doc.get("scene", 0)].setdefault("nodes", []).append(
            len(live_doc["nodes"]) - 1
        )
    moon["mesh"] = mesh0
    moon["name"] = "Moon_0"
    moon["scale"] = [1, 1, 1]
    moon.pop("translation", None)
    moon.pop("rotation", None)

    live_doc.setdefault("extras", {})
    live_doc["extras"]["rtsMesaHeightfield"] = {
        "res": RES,
        "half": HALF,
        "method": "user-heightmap+color-topdown",
        "source": "ref-heightmap.png / ref-topdown.jpg",
    }
    live_doc["extras"].pop("rtsMegascansCanyon", None)

    out = LIVE if WRITE_LIVE else os.path.join(MESA, "terrain-from-heightmap.glb")
    if WRITE_LIVE and not os.path.isfile(LIVE + ".pre-user-hm.bak") and os.path.isfile(LIVE):
        open(LIVE + ".pre-user-hm.bak", "wb").write(open(LIVE, "rb").read())
    write_glb(out, live_doc, new_bin)
    print("wrote", out, os.path.getsize(out))
    if not WRITE_LIVE:
        print("Dry-run — WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1")


def main():
    if not os.path.isfile(HM) or not os.path.isfile(COL):
        print("missing refs", HM, COL)
        sys.exit(1)
    print("building mesh RES", RES, "H_SCALE", H_SCALE)
    verts, normals, uvs, colors, indices, h_min, h_max = build_mesh()
    print("height", round(h_min, 3), round(h_max, 3), "tris", len(indices) // 3)
    plate = os.path.join(MESA, "skirmish-from-heightmap.glb")
    write_plate_glb(plate, verts, normals, uvs, colors, indices)
    print("wrote", plate, os.path.getsize(plate))
    merge_into_live(plate)


if __name__ == "__main__":
    main()
