"""
Compress lumen_hologram_table.src.glb → lumen_hologram_table.glb

Uses Meta-recommended KTX 2.0 / Basis Universal (KHR_texture_basisu):
  - Resize textures to 1024
  - ETC1S for baseColor + emissive
  - UASTC for normal + occlusion/metallicRoughness

Requires:
  - Node.js + npx @gltf-transform/cli
  - KTX-Software `toktx` on PATH (https://github.com/KhronosGroup/KTX-Software)

Run from repo (PowerShell):
  $env:Path = "C:\\Program Files\\KTX-Software\\bin;" + $env:Path
  python blender/compress_lumen_table.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
SRC = ASSETS / "lumen_hologram_table.src.glb"
OUT = ASSETS / "lumen_hologram_table.glb"
MIN_COPY = ASSETS / "lumen_hologram_table.min.glb"
TMP = ASSETS / "_lumen_ktx_work.glb"
GLTF = ["npx", "--yes", "@gltf-transform/cli@4.1.1"]


def run(args: list[str]) -> None:
    print("+", " ".join(args))
    subprocess.check_call(args)


def main() -> None:
    if not SRC.is_file():
        sys.exit(f"missing source: {SRC}")
    if not shutil.which("toktx"):
        sys.exit("toktx not on PATH — install KTX-Software and add its bin/ folder")

    run([*GLTF, "resize", str(SRC), str(TMP), "--width", "1024", "--height", "1024"])
    run(
        [
            *GLTF,
            "etc1s",
            str(TMP),
            str(TMP),
            "--slots",
            "{baseColorTexture,emissiveTexture}",
            "--quality",
            "160",
            "--compression",
            "2",
        ]
    )
    run(
        [
            *GLTF,
            "uastc",
            str(TMP),
            str(OUT),
            "--slots",
            "{normalTexture,occlusionTexture,metallicRoughnessTexture}",
            "--level",
            "2",
            "--rdo",
            "--rdo-lambda",
            "0.5",
            "--zstd",
            "18",
        ]
    )
    TMP.unlink(missing_ok=True)
    shutil.copyfile(OUT, MIN_COPY)
    run([*GLTF, "inspect", str(OUT)])
    print("done", OUT, f"({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
