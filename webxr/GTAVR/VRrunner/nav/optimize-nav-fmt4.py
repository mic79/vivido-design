#!/usr/bin/env python3
"""Convert DV2N fmt=2/3 → fmt=4 (uint32 walk list + int16 Y + water bitmap + gzip)."""
import gzip
import struct
import sys


def read_header(f):
    magic = f.read(4)
    if magic != b"DV2N":
        raise SystemExit("bad magic")
    fmt = struct.unpack("<I", f.read(4))[0]
    if fmt not in (2, 3):
        raise SystemExit(f"input must be fmt 2 or 3, got {fmt}")
    keylen = struct.unpack("<H", f.read(2))[0]
    key = f.read(keylen)
    pad = (4 - ((10 + keylen) % 4)) % 4
    f.read(pad)
    gw, gh = struct.unpack("<II", f.read(8))
    cell_size, min_x, min_z = struct.unpack("<fff", f.read(12))
    lcid = struct.unpack("<i", f.read(4))[0]
    return fmt, key, gw, gh, cell_size, min_x, min_z, lcid


def read_sparse_body(f, fmt):
    walk_n = struct.unpack("<I", f.read(4))[0]
    walk_idx = []
    walk_y = []
    for _ in range(walk_n):
        idx = struct.unpack("<I", f.read(4))[0]
        fy = struct.unpack("<f", f.read(4))[0]
        walk_idx.append(idx)
        walk_y.append(fy)
    water_n = struct.unpack("<I", f.read(4))[0]
    water_set = set()
    for _ in range(water_n):
        idx = struct.unpack("<I", f.read(4))[0]
        f.read(4)
        water_set.add(idx)
    if fmt == 2:
        grey_n = struct.unpack("<I", f.read(4))[0]
        f.read(grey_n * 4)
    return walk_idx, walk_y, water_set


def build_payload(gw, gh, walk_idx, walk_y, water_set):
    total = gw * gh
    bm = bytearray((total + 7) // 8)
    for idx in water_set:
        bm[idx >> 3] |= 1 << (idx & 7)

    body = bytearray()
    body += struct.pack("<I", len(walk_idx))
    for idx in walk_idx:
        body += struct.pack("<I", idx)
    for y in walk_y:
        q = max(-32768, min(32767, int(round(y * 20))))
        body += struct.pack("<h", q)
    body += struct.pack("<I", len(bm))
    body += bm
    return bytes(body)


def write_fmt4(out_path, key, gw, gh, cell_size, min_x, min_z, lcid, payload, gzip_level=9):
    compressed = gzip.compress(payload, compresslevel=gzip_level)
    keylen = len(key)
    pad = (4 - ((10 + keylen) % 4)) % 4
    header_len = 10 + keylen + pad + 28 + 8
    with open(out_path, "wb") as o:
        o.write(b"DV2N")
        o.write(struct.pack("<I", 4))
        o.write(struct.pack("<H", keylen))
        o.write(key)
        o.write(b"\0" * pad)
        o.write(struct.pack("<II", gw, gh))
        o.write(struct.pack("<fff", cell_size, min_x, min_z))
        o.write(struct.pack("<i", lcid))
        o.write(struct.pack("<I", len(payload)))
        o.write(struct.pack("<I", len(compressed)))
        o.write(compressed)
    return header_len + len(compressed)


def main():
    if len(sys.argv) != 3:
        print("usage: optimize-nav-fmt4.py input.nav.bin output.nav.opt.bin", file=sys.stderr)
        sys.exit(1)
    inp, outp = sys.argv[1], sys.argv[2]
    with open(inp, "rb") as f:
        fmt, key, gw, gh, cs, min_x, min_z, lcid = read_header(f)
        walk_idx, walk_y, water_set = read_sparse_body(f, fmt)
    payload = build_payload(gw, gh, walk_idx, walk_y, water_set)
    out_size = write_fmt4(outp, key, gw, gh, cs, min_x, min_z, lcid, payload)
    import os
    in_size = os.path.getsize(inp)
    print(
        f"OK {outp}\n"
        f"  input:  {in_size/1048576:.2f} MB (fmt={fmt})\n"
        f"  output: {out_size/1048576:.2f} MB (fmt=4 gzip)\n"
        f"  walk {len(walk_idx):,} · water bitmap {len(water_set):,} cells · "
        f"payload {len(payload)/1048576:.2f} MB raw (flat uint32)"
    )


if __name__ == "__main__":
    main()
