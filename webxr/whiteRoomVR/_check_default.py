from playwright.sync_api import sync_playwright
from pathlib import Path
import json

OUT = Path(__file__).resolve().parent / "_shots"
OUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errs = []
    logs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: logs.append(f"{m.type}:{m.text}") if m.type in ("error", "warning") or "white-room" in m.text else None)
    page.goto("http://localhost:8080/whiteRoomVR/?v=90", wait_until="networkidle", timeout=90000)
    page.wait_for_timeout(8000)
    page.screenshot(path=str(OUT / "v90_default.png"), full_page=False)
    info = page.evaluate(
        """() => {
      const scene = document.querySelector('a-scene').object3D;
      let tables = 0, shaders = 0;
      scene.traverse(o => {
        if (!o.isMesh) return;
        const n = (o.name||'') + ' ' + (o.parent&&o.parent.name||'');
        const mats = [].concat(o.material||[]);
        for (const m of mats) {
          if (m && m.type === 'ShaderMaterial' && m.uniforms && m.uniforms.envMap) shaders++;
        }
        if (/geosynth|lumen|table|holi/i.test(n) || (o.parent && /Scene/.test(o.parent.type))) {
          // count mesh with map named-ish
        }
      });
      const children = scene.children.map(c => ({type:c.type, name:c.name, nChild:c.children.length, pos:[+c.position.x.toFixed(2),+c.position.y.toFixed(2),+c.position.z.toFixed(2)]}));
      return { shaders, childCount: scene.children.length, children: children.slice(0, 30) };
    }"""
    )
    print(json.dumps({"info": info, "errs": errs[:10], "logs": logs[:20]}, indent=2))
    browser.close()
