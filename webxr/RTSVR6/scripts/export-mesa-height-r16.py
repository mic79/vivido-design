"""
Create a UE Landscape-friendly 16-bit height RAW from the skirmish mesa heightfield.
Import in UE: Landscape → Import from File → skirmish-mesa-height.r16
(resolution must match; default 256).

Also writes a PNG preview.

Does not place actors — geometry is authored as height data (same idea as crater).
"""
from __future__ import annotations

import json
import os
import struct

ROOT = r"D:\backup 2024-04\Documents\Backup_MBP_2021-12\Backup\Projects\Apps\WebXR\RTSVR6\assets\mesa"
META = os.path.join(ROOT, "skirmish-mesa-height.json")
BIN = os.path.join(ROOT, "skirmish-mesa-height.bin")
OUT_R16 = os.path.join(ROOT, "skirmish-mesa-height.r16")


def main():
    with open(META, "r", encoding="utf-8") as f:
        meta = json.load(f)
    res = int(meta["res"])
    h_min = float(meta["hMin"])
    h_max = float(meta["hMax"])
    raw = open(BIN, "rb").read()
    # Float32 grid
    n = res * res
    vals = struct.unpack("<%df" % n, raw[: n * 4])
    span = max(1e-6, h_max - h_min)
    out = bytearray()
    for h in vals:
        u = int(max(0, min(65535, round(((h - h_min) / span) * 65535))))
        out += struct.pack("<H", u)
    with open(OUT_R16, "wb") as f:
        f.write(out)
    print("wrote", OUT_R16, "res", res, "h", h_min, h_max)


if __name__ == "__main__":
    main()
