#!/usr/bin/env python3
"""
Copy BAR Hera splat detail (DNTS) into project-local assets for runtime.
These tiled layers are what give Spring/BAR close-up resolution — the SMT
macro map alone cannot (max 10240×8192 over the whole plate).
"""
from __future__ import annotations

import os
import shutil

from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
HERA = os.path.join(ROOT, "assets", "mesa", "hera-planum")
MAPS = os.path.join(HERA, "_sd7", "maps")
OUT = os.path.join(HERA, "splat")

# mapinfo.lua resources + splats
FILES = [
    ("hera_planum_splat_distribution.tga", "distr.png"),
    ("rocky-bacon2K.png", "dnts1.png"),
    ("ground009.tga", "dnts2.png"),
    ("small_rocks.tga", "dnts3.png"),
    ("cracks_2_dnts_.tga", "dnts4.png"),
]


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for src_name, dst_name in FILES:
        src = os.path.join(MAPS, src_name)
        if not os.path.isfile(src):
            raise SystemExit(f"missing {src} — extract sd7 first")
        im = Image.open(src).convert("RGBA")
        dst = os.path.join(OUT, dst_name)
        im.save(dst, "PNG", optimize=True)
        print(f"wrote {dst} {im.size} {os.path.getsize(dst)}")
    open(os.path.join(OUT, "SOURCE.txt"), "w", encoding="utf-8").write(
        "From hera_planum_0.91.sd7 mapinfo.lua splatDetailNormalTex1..4 + splatDistrTex.\n"
        "TexScales {0.003, 0.004, 0.0032, 0.0025} TexMults {0.85, 0.5, 0.43, 0.36}\n"
        "splatDetailNormalDiffuseAlpha=1 (RGB=normal, A=diffuse detail).\n"
    )
    print("done", OUT)


if __name__ == "__main__":
    main()
