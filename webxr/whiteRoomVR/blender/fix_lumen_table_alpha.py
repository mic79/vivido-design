"""Fix lumen table alpha: Sketchfab exported one BLEND material for all meshes.

Splits into opaque body + blended glass/shaft so depth sorting works in Three.js.
"""
from __future__ import annotations

import copy
import json
import struct
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
# Prefer already-KTX2 asset; fall back to source
IN = ASSETS / "lumen_hologram_table.glb"
SRC_FALLBACK = ASSETS / "lumen_hologram_table.src.glb"
OUT = ASSETS / "lumen_hologram_table.glb"
MIN_COPY = ASSETS / "lumen_hologram_table.min.glb"


def read_glb(path: Path):
    data = path.read_bytes()
    assert data[:4] == b"glTF"
    offset = 12
    gltf = None
    blob = None
    while offset + 8 <= len(data):
        clen, ctype = struct.unpack_from("<I4s", data, offset)
        chunk = data[offset + 8 : offset + 8 + clen]
        if ctype == b"JSON":
            gltf = json.loads(chunk)
        elif ctype.startswith(b"BIN"):
            blob = chunk
        offset += 8 + clen
    return gltf, blob


def write_glb(path: Path, gltf: dict, blob: bytes) -> None:
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (4 - (len(json_bytes) % 4)) % 4
    json_bytes += b" " * json_pad
    bin_pad = (4 - (len(blob) % 4)) % 4
    blob = blob + (b"\x00" * bin_pad)
    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    out = bytearray()
    out += struct.pack("<4sII", b"glTF", 2, total)
    out += struct.pack("<I4s", len(json_bytes), b"JSON")
    out += json_bytes
    out += struct.pack("<I4s", len(blob), b"BIN\x00")
    out += blob
    path.write_bytes(out)


def mesh_role(gltf: dict, mesh_index: int) -> str:
    """Map mesh index → role via parent node name (Glass / shaft / table_holi)."""
    for node in gltf["nodes"]:
        if node.get("mesh") != mesh_index:
            continue
        # Walk: defaultMaterial node → named parent
        # Find who has this node as child
    # Build child→parent
    parent = {}
    for i, node in enumerate(gltf["nodes"]):
        for c in node.get("children") or []:
            parent[c] = i
    for i, node in enumerate(gltf["nodes"]):
        if node.get("mesh") != mesh_index:
            continue
        # climb for a meaningful name
        cur = i
        for _ in range(6):
            name = (gltf["nodes"][cur].get("name") or "").lower()
            if "glass" in name:
                return "glass"
            if "shaft" in name:
                return "shaft"
            if "table" in name or "holi" in name:
                return "body"
            if cur not in parent:
                break
            cur = parent[cur]
    return "body"


def main() -> None:
    path = IN if IN.is_file() else SRC_FALLBACK
    gltf, blob = read_glb(path)
    base = gltf["materials"][0]

    body = copy.deepcopy(base)
    body["name"] = "table_body"
    body["alphaMode"] = "OPAQUE"
    body.pop("alphaCutoff", None)

    glass = copy.deepcopy(base)
    glass["name"] = "table_glass"
    glass["alphaMode"] = "BLEND"
    glass["doubleSided"] = True

    shaft = copy.deepcopy(base)
    shaft["name"] = "table_shaft"
    shaft["alphaMode"] = "BLEND"
    shaft["doubleSided"] = True

    gltf["materials"] = [body, glass, shaft]
    role_to_mat = {"body": 0, "glass": 1, "shaft": 2}

    for mi, mesh in enumerate(gltf["meshes"]):
        role = mesh_role(gltf, mi)
        mat_i = role_to_mat[role]
        for prim in mesh["primitives"]:
            prim["material"] = mat_i
        print(f"mesh {mi} -> {role} material {mat_i} ({gltf['materials'][mat_i]['name']})")

    write_glb(OUT, gltf, blob)
    MIN_COPY.write_bytes(OUT.read_bytes())
    print("wrote", OUT, f"({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
