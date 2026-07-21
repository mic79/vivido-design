"""Confirm probe is the real room (no softbox studio), then screenshot tables."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import base64
import json
import re

OUT = Path(__file__).resolve().parent / "_shots"
OUT.mkdir(exist_ok=True)
BASE = "http://localhost:8080/whiteRoomVR/?v=97"


def run(label, query):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        logs = []
        page.on("console", lambda m: logs.append(m.text) if "white-room" in m.text else None)
        page.goto(BASE + query, wait_until="networkidle", timeout=90000)
        page.wait_for_timeout(8000)
        path = OUT / f"v97_{label}.png"
        page.screenshot(path=str(path), full_page=False)
        dumped = page.evaluate(
            """() => {
          const c = document.querySelector('a-scene').object3D.userData.liveRoomEquirectRT;
          if (!c || !c.canvas) return null;
          return c.canvas.toDataURL('image/png');
        }"""
        )
        if dumped:
            (OUT / f"v97_{label}_equirect.png").write_bytes(
                base64.b64decode(dumped.split(",")[1])
            )
        equirect = next((t for t in logs if "equirect pixels" in t), "")
        browser.close()
        m = re.search(r"mean:\s*(\d+).*min:\s*(\d+).*max:\s*(\d+)", equirect or "")
        return {
            "label": label,
            "shot": str(path),
            "log": equirect,
            "probe": {"mean": int(m.group(1)), "min": int(m.group(2)), "max": int(m.group(3))} if m else None,
        }


results = [run("envOnly", "&envOnly=1&debugEnv=1"), run("normal", "")]
print(json.dumps(results, indent=2))
# Real white room probe should be bright overall (walls), not dark studio mean~20-40
probe = results[0]["probe"]
if not probe or probe["mean"] < 80:
    raise SystemExit(f"FAIL: probe still looks like dark studio ({probe})")
if probe["max"] - probe["min"] < 20:
    raise SystemExit(f"FAIL: probe flat ({probe})")
print("PASS: bright live-room probe")
