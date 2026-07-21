from playwright.sync_api import sync_playwright
from pathlib import Path
import json

OUT = Path(
    r"d:\backup 2024-04\Documents\Backup_MBP_2021-12\Backup\Projects\Apps\WebXR\whiteRoomVR\_shots"
)
OUT.mkdir(exist_ok=True)

JS = """
() => {
  const sceneEl = document.querySelector("a-scene");
  const renderer = sceneEl.renderer;
  const scene = sceneEl.object3D;
  const AT = AFRAME.THREE;
  // Use A-Frame THREE for RT+camera (same as renderer)
  const faceSize = 256;
  const faceRT = new AT.WebGLRenderTarget(faceSize, faceSize, {
    type: AT.UnsignedByteType,
    format: AT.RGBAFormat,
    depthBuffer: true,
  });
  const cam = new AT.PerspectiveCamera(90, 1, 0.1, 80);
  cam.position.set(0, 1.5, 0);
  cam.up.set(0, -1, 0);
  cam.lookAt(1, 1.5, 0);
  cam.updateMatrixWorld(true);

  const prev = {
    rt: renderer.getRenderTarget(),
    autoClear: renderer.autoClear,
    xr: renderer.xr.enabled,
    tone: renderer.toneMapping,
    bg: scene.background,
  };
  renderer.xr.enabled = false;
  renderer.autoClear = true;
  renderer.toneMapping = AT.NoToneMapping;
  scene.background = new AT.Color(0x1a2224);
  renderer.setRenderTarget(faceRT);
  renderer.clear();
  renderer.render(scene, cam);

  const buf = new Uint8Array(faceSize * faceSize * 4);
  renderer.readRenderTargetPixels(faceRT, 0, 0, faceSize, faceSize, buf);
  let min = 255, max = 0, sum = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i];
    sum += r;
    if (r < min) min = r;
    if (r > max) max = r;
  }

  // Show face on a debug plane via GPU texture (no CPU)
  const plane = new AT.Mesh(
    new AT.PlaneGeometry(4, 4),
    new AT.MeshBasicMaterial({ map: faceRT.texture, toneMapped: false })
  );
  plane.position.set(0, 1.8, 5);
  plane.rotation.y = Math.PI;
  plane.name = "FaceDebug";
  scene.add(plane);
  window.__faceRT = faceRT;

  renderer.setRenderTarget(prev.rt);
  renderer.autoClear = prev.autoClear;
  renderer.xr.enabled = prev.xr;
  renderer.toneMapping = prev.tone;
  scene.background = prev.bg;

  return {
    path: "AFRAME.THREE",
    min,
    max,
    mean: Math.round(sum / (faceSize * faceSize)),
  };
}
"""

JS2 = """
() => {
  const sceneEl = document.querySelector("a-scene");
  const renderer = sceneEl.renderer;
  const scene = sceneEl.object3D;
  // Import CDN three via dynamic - use whatever GlossyReflector used
  // Grab from an existing CDN mesh constructor
  const floor = [...scene.children].find((c) => c.type === "Mesh" && c.material && c.material.type === "ShaderMaterial");
  // fallback: create via eval of module not available
  return { hasFloor: !!floor, childTypes: scene.children.slice(0, 8).map((c) => c.type + ':' + (c.name||'')) };
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    logs = []
    page.on(
        "console",
        lambda m: logs.append(m.type + ":" + m.text)
        if "white-room" in m.text or "equirect" in m.text
        else None,
    )
    page.goto(
        "http://localhost:8080/whiteRoomVR/?v=87",
        wait_until="networkidle",
        timeout=90000,
    )
    page.wait_for_timeout(6000)
    r = page.evaluate(JS)
    print("AFRAME RT:", json.dumps(r))
    page.wait_for_timeout(1500)
    page.screenshot(path=str(OUT / "face_debug_aframe.png"), full_page=False)
    print("wrote face_debug_aframe.png")
    for L in logs:
        print(L)
    browser.close()
