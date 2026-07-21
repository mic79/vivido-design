from playwright.sync_api import sync_playwright
import json

JS = """
() => {
  const scene = document.querySelector('a-scene').object3D;
  const tables = [];
  for (const c of scene.children) {
    if (c.name === 'Sketchfab_Scene') {
      const mats = [];
      c.traverse(o => {
        if (!o.isMesh || !o.material) return;
        const list = [].concat(o.material);
        for (const m of list) {
          mats.push({
            mesh: o.name,
            mat: m.name,
            type: m.type,
            transparent: !!m.transparent,
            depthWrite: m.depthWrite,
            hasEnvU: !!(m.uniforms && m.uniforms.envMap),
            gloss: m.uniforms && m.uniforms.gloss && m.uniforms.gloss.value,
            map: !!(m.map || (m.uniforms && m.uniforms.map && m.uniforms.map.value)),
          });
        }
      });
      tables.push({ pos: [c.position.x, c.position.y, c.position.z], mats });
    }
  }
  return tables;
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 800, "height": 600})
    page.goto("http://localhost:8080/whiteRoomVR/?v=92", wait_until="networkidle", timeout=90000)
    page.wait_for_timeout(6000)
    print(json.dumps(page.evaluate(JS), indent=2))
    browser.close()
