#!/usr/bin/env python3
"""
Extract Hera Planum diffuse from SMT using correct Spring tile size (680 B =
DXT1 32×32 + 3 mip levels). Prior 512 B reads were misaligned and produced
the tiled garbage. SMF tile index map selects which SMT tile goes where.
"""
from __future__ import annotations

import os
import struct
import sys

from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
HERA = os.path.join(ROOT, "assets", "mesa", "hera-planum")
MAPS = os.path.join(HERA, "_sd7", "maps")
SMT = os.path.join(MAPS, "hera_planum.smt")
SMF = os.path.join(MAPS, "hera_planum.smf")
NRM_DDS = os.path.join(MAPS, "hera_planum_normals.dds")
# Native SMT is 10240×8192 — keep full res (Quest max texture usually ≥16384).
TEX_MAX = int(os.environ.get("TEX_MAX", "10240"))

# Spring SMT: 32×32 DXT1 mip0 (512) + mip1..3 (128+32+8) = 680
TILE = 32
TILE_BYTES = 680
MIP0_BYTES = 512
TILE_MASK = (1 << 29) - 1


def decode_dxt1_block(block: bytes, ox: int, oy: int, w: int, pixels: bytearray) -> None:
    c0, c1 = struct.unpack_from("<HH", block, 0)
    bits = struct.unpack_from("<I", block, 4)[0]

    def rgb565(c: int):
        r = ((c >> 11) & 31) * 255 // 31
        g = ((c >> 5) & 63) * 255 // 63
        b = (c & 31) * 255 // 31
        return r, g, b

    a, b = rgb565(c0), rgb565(c1)
    if c0 > c1:
        colors = [
            a,
            b,
            ((2 * a[0] + b[0]) // 3, (2 * a[1] + b[1]) // 3, (2 * a[2] + b[2]) // 3),
            ((a[0] + 2 * b[0]) // 3, (a[1] + 2 * b[1]) // 3, (a[2] + 2 * b[2]) // 3),
        ]
    else:
        colors = [
            a,
            b,
            ((a[0] + b[0]) // 2, (a[1] + b[1]) // 2, (a[2] + b[2]) // 2),
            (0, 0, 0),
        ]
    for j in range(4):
        for i in range(4):
            x, y = ox + i, oy + j
            if x >= w or y >= w:
                continue
            idx = (bits >> (2 * (4 * j + i))) & 3
            o = (y * w + x) * 3
            r, g, bb = colors[idx]
            pixels[o] = r
            pixels[o + 1] = g
            pixels[o + 2] = bb


def decode_mip0_tile(raw680: bytes) -> bytearray:
    """Decode only the 32×32 mip0 (first 512 bytes)."""
    pixels = bytearray(TILE * TILE * 3)
    mip0 = raw680[:MIP0_BYTES]
    for by in range(TILE // 4):
        for bx in range(TILE // 4):
            bi = (by * (TILE // 4) + bx) * 8
            decode_dxt1_block(mip0[bi : bi + 8], bx * 4, by * 4, TILE, pixels)
    return pixels


def read_smf_tilemap(path: str):
    data = open(path, "rb").read()
    if not data.startswith(b"spring map file"):
        raise SystemExit("bad SMF")
    _ver, _id, mapx, mapy = struct.unpack_from("<4i", data, 16)
    _sq, texels, _ts = struct.unpack_from("<3i", data, 32)
    tiles_ptr = struct.unpack_from("<i", data, 52 + 8)[0]  # 3rd ptr after height/type
    # ptrs start at offset 52: height, type, tiles, mini, metal, feature
    ptrs = struct.unpack_from("<6i", data, 52)
    tiles_ptr = ptrs[2]
    num_files, num_tiles = struct.unpack_from("<2i", data, tiles_ptr)
    off = tiles_ptr + 8
    _ntf = struct.unpack_from("<i", data, off)[0]
    off += 4
    start = off
    while data[off] != 0:
        off += 1
    name = data[start:off].decode("ascii", "replace")
    off += 1  # tilemap immediately after NUL (no extra align)
    tw, th = mapx // 4, mapy // 4
    expect = tw * th
    idxs = list(struct.unpack_from("<%di" % expect, data, off))
    pix_w, pix_h = mapx * texels, mapy * texels
    print(f"SMF {mapx}x{mapy} tiles {tw}x{th} px {pix_w}x{pix_h} smt={name}")
    print(f"  idxs head={idxs[:8]} range={min(idxs)}..{max(idxs)} unique={len(set(i & TILE_MASK for i in idxs))}")
    return tw, th, pix_w, pix_h, idxs, num_tiles


def load_smt_tiles(path: str) -> list[bytes]:
    with open(path, "rb") as f:
        magic = f.read(16)
        if not magic.startswith(b"spring tilefile"):
            raise SystemExit("bad SMT")
        ver, n, tile_size, comp = struct.unpack("<4i", f.read(16))
        if ver != 1 or tile_size != 32 or comp != 1:
            raise SystemExit(f"unsupported SMT {ver}/{tile_size}/{comp}")
        expect_size = 32 + n * TILE_BYTES
        actual = os.path.getsize(path)
        if actual != expect_size:
            print(f"warn: size {actual} != 32+{n}*{TILE_BYTES}={expect_size}")
        tiles = []
        for i in range(n):
            if i % 10000 == 0:
                print(f"  SMT {i}/{n}", flush=True)
            tiles.append(f.read(TILE_BYTES))
        return tiles


def assemble(tw, th, pix_w, pix_h, idxs, tiles: list[bytes]) -> Image.Image:
    pixels = bytearray(pix_w * pix_h * 3)
    for ty in range(th):
        if ty % 32 == 0:
            print(f"  row {ty}/{th}", flush=True)
        for tx in range(tw):
            raw_idx = idxs[ty * tw + tx]
            flip_x = bool(raw_idx & (1 << 29))
            flip_y = bool(raw_idx & (1 << 30))
            ti = raw_idx & TILE_MASK
            if ti >= len(tiles):
                continue
            scratch = decode_mip0_tile(tiles[ti])
            for j in range(TILE):
                sj = (TILE - 1 - j) if flip_y else j
                for i in range(TILE):
                    si = (TILE - 1 - i) if flip_x else i
                    src = (sj * TILE + si) * 3
                    dst = ((ty * TILE + j) * pix_w + (tx * TILE + i)) * 3
                    pixels[dst : dst + 3] = scratch[src : src + 3]
    return Image.frombytes("RGB", (pix_w, pix_h), bytes(pixels))


def save_capped(im: Image.Image, path: str, quality: int = 92) -> None:
    im = im.convert("RGB")
    w, h = im.size
    scale = min(1.0, TEX_MAX / max(w, h))
    if scale < 1.0:
        nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        im = im.resize((nw, nh), Image.Resampling.LANCZOS)
        print(f"  resize {w}x{h} -> {nw}x{nh}")
    im.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"wrote {path} {im.size} {os.path.getsize(path)}")


def main() -> None:
    if not (os.path.isfile(SMT) and os.path.isfile(SMF)):
        print("missing SMT/SMF — extract hera_planum_0.91.sd7 first")
        sys.exit(1)
    tw, th, pix_w, pix_h, idxs, _n = read_smf_tilemap(SMF)
    tiles = load_smt_tiles(SMT)
    print("assembling…")
    diff = assemble(tw, th, pix_w, pix_h, idxs, tiles)
    # Preview before shipping
    prev = os.path.join(HERA, "_verify_smt_overview.jpg")
    diff.resize((1024, 820), Image.Resampling.BOX).save(prev, quality=85)
    print("preview", prev)

    out = os.path.join(HERA, "diffuse-8k.jpg")
    save_capped(diff, out)
    # Also copy as the runtime HQ path (lossless-ish jpeg is fine at 8k)
    hq = os.path.join(HERA, "diffuse-hq.jpg")
    save_capped(diff, hq, quality=93)

    if os.path.isfile(NRM_DDS):
        nrm = Image.open(NRM_DDS).convert("RGB")
        save_capped(nrm, os.path.join(HERA, "normal-8k.jpg"))
        save_capped(nrm, os.path.join(HERA, "normal-hq.jpg"), quality=93)

    # Only mark OK after human-scale preview exists; loader prefers diffuse-hq.jpg
    open(os.path.join(HERA, "diffuse-8k.jpg.ok"), "w", encoding="utf-8").write(
        f"{diff.size[0]}x{diff.size[1]} tileBytes={TILE_BYTES}\n"
    )
    print("done — check _verify_smt_overview.jpg before trusting in-game")


if __name__ == "__main__":
    main()
