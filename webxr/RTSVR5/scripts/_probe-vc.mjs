import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8836;
const VER = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").match(/content="([^"]+)"/)[1];
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
await page.waitForTimeout(2000);
const info = await page.evaluate(()=>{
  const rows=[];
  document.querySelector("a-scene")?.object3D?.traverse(o=>{
    if(!o.isMesh || !/circularplatform/i.test(o.name||"")) return;
    const m = Array.isArray(o.material)?o.material[0]:o.material;
    const col = o.geometry?.attributes?.color;
    let cmin=1,cmax=0,csum=0;
    if(col){
      for(let i=0;i<col.count;i++){ const v=col.getX(i); cmin=Math.min(cmin,v); cmax=Math.max(cmax,v); csum+=v; }
    }
    rows.push({
      name:o.name,
      parent:o.parent?.name,
      visible:o.visible,
      vc:!!m?.vertexColors,
      hero:!!m?.userData?.rtsHeroLm,
      env:m?.envMapIntensity,
      metal:m?.metalness,
      hasColor:!!col,
      cmin: col?+cmin.toFixed(3):null,
      cmax: col?+cmax.toFixed(3):null,
      cmean: col?+(csum/col.count).toFixed(3):null,
      draws: o.isInstancedMesh ? o.count : 1,
    });
  });
  return rows.slice(0,15);
});
console.log(JSON.stringify(info,null,2));
await browser.close(); server.close();
