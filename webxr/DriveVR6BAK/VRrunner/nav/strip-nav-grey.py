#!/usr/bin/env python3
"""Strip grey column list from DV2N fmt=2 nav → smaller fmt=3 (walk + water only)."""
import struct
import sys


def read_header(f):
    magic = f.read(4)
    if magic != b"DV2N":
        raise SystemExit("bad magic (expected DV2N)")
    fmt = struct.unpack("<I", f.read(4))[0]
    if fmt != 2:
        raise SystemExit(f"expected fmt=2, got {fmt} (already fmt=3 or dense fmt=1?)")
    keylen = struct.unpack("<H", f.read(2))[0]
    key = f.read(keylen)
    pad = (4 - ((10 + keylen) % 4)) % 4
    f.read(pad)
    gw, gh = struct.unpack("<II", f.read(8))
    cell_size, min_x, min_z = struct.unpack("<fff", f.read(12))
    lcid = struct.unpack("<i", f.read(4))[0]
    return key, gw, gh, cell_size, min_x, min_z, lcid


def main():
    if len(sys.argv) != 3:
        print("usage: strip-nav-grey.py input.nav.bin output.nav.opt.bin", file=sys.stderr)
        sys.exit(1)
    inp, outp = sys.argv[1], sys.argv[2]
    with open(inp, "rb") as f:
        key, gw, gh, cell_size, min_x, min_z, lcid = read_header(f)
        walk_n = struct.unpack("<I", f.read(4))[0]
        walk_blob = f.read(walk_n * 8)
        water_n = struct.unpack("<I", f.read(4))[0]
        water_blob = f.read(water_n * 8)
        grey_n = struct.unpack("<I", f.read(4))[0]
        f.read(grey_n * 4)

    o_before_key = 10
    key_pad = (4 - ((o_before_key + len(key)) % 4)) % 4
    header = o_before_key + len(key) + key_pad + 6 * 4 + 12
    body = len(walk_blob) + len(water_blob) + 12
    out_size = header + body

    with open(outp, "wb") as o:
        o.write(b"DV2N")
        o.write(struct.pack("<I", 3))
        o.write(struct.pack("<H", len(key)))
        o.write(key)
        o.write(b"\0" * key_pad)
        o.write(struct.pack("<II", gw, gh))
        o.write(struct.pack("<fff", cell_size, min_x, min_z))
        o.write(struct.pack("<i", lcid))
        o.write(struct.pack("<I", walk_n))
        o.write(walk_blob)
        o.write(struct.pack("<I", water_n))
        o.write(water_blob)

    print(
        f"wrote {outp}: fmt=3, walk={walk_n:,}, water={water_n:,}, "
        f"dropped grey={grey_n:,}, size={out_size/1048576:.2f} MB"
    )


if __name__ == "__main__":
    main()
