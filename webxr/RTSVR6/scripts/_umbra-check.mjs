import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8837;
const VER = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").match(/name="rts-version"\s+content="([^"]+)"/)[1];
const MIME = { ".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".glb":"model/gltf-binary",".png":"image/png",".jpg":"image/jpeg",".json":"application/json",".wasm":"application/wasm",".hdr":"application/octet-stream" };
const server = http.createServer((req,res)=>{ let rel=decodeURIComponent(new URL(req.url,"http://x").pathname); if(rel==="/") rel="/index.html"; const fp=path.normalize(path.join(ROOT,rel)); if(!fp.startsWith(ROOT)||!fs.existsSync(fp)){res.writeHead(404);return res.end();} res.writeHead(200,{"Content-Type":MIME[path.extname(fp)]||"application/octet-stream","Cache-Control":"no-store"}); fs.createReadStream(fp).pipe(res); });
await new Promise(r=>server.listen(PORT,"127.0.0.1",r));
const browser = await chromium.launch({headless:true, args:["--use-gl=angle","--ignore-gpu-blocklist"]});
const page = await browser.newPage({viewport:{width:1280,height:720}});
await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&scenery=B0&v=${VER}`,{waitUntil:"domcontentloaded",timeout:180000});
await page.waitForFunction(()=>window.__rtsReady===true,null,{timeout:240000});
await page.evaluate(()=>window._dismissAppStartGate?.());
await page.waitForTimeout(300);
await page.evaluate(()=>{ window._setDynamicShadowsEnabled?.(false); window._startGame("1v1"); });
await page.waitForFunction(()=>{ const o=document.getElementById("match-prepare-overlay"); return !(o&&!o.hidden); },null,{timeout:300000});
await page.waitForTimeout(1500);
const info = await page.evaluate(()=>{
  const THREE=window.THREE;
  let c=null;
  document.querySelector("a-scene")?.object3D?.traverse(o=>{
    if(!o.isMesh||!/circularplatform/i.test(o.name||"")) return;
    o.updateMatrixWorld(true);
    const b=new THREE.Box3().setFromObject(o);
    c=b.getCenter(new THREE.Vector3());
  });
  window.__rtsCameraRigPose?.({x:c.x+5,y:10,z:c.z+6,rotY:-0.35});
  return {c:c?.toArray(), pose: window.__rtsCameraRigPose?.()};
});
await page.waitForTimeout(500);
const after = await page.evaluate(()=>{
  const rig=document.getElementById("cameraRig")?.object3D;
  const cam=document.getElementById("camera")?.object3D;
  return {
    pose: window.__rtsCameraRigPose?.(),
    rig: rig? [rig.position.x,rig.position.y,rig.position.z]:null,
    camRot: cam? [cam.rotation.x,cam.rotation.y,cam.rotation.z]:null,
  };
});
const out = path.join(ROOT,"bench-poses","hero-lm-umbra-check-0.5.116.png");
await page.screenshot({path:out, fullPage:false});
console.log(JSON.stringify({info, after, out},null,2));
await browser.close(); server.close();
