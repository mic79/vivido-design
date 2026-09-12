import fs from 'node:fs';

const src = new URL('../js/renderer.js', import.meta.url);
const dst = new URL('../../RTSVR5Forest/js/renderer.js', import.meta.url);
let a = fs.readFileSync(src, 'utf8');
let b = fs.readFileSync(dst, 'utf8');

b = b.replace(
  /const FOCUS_RING_SEGMENTS = 96;\r?\n[\s\S]*?(?=\/\*\* Destination rings for selected units)/,
  'const FOCUS_RING_SEGMENTS = 96;\nconst FOCUS_FADE_OPAQUE_SLACK_M = 6;\n'
);

const start = '/**\n * Drive focus fade through the same terrain-shader darken path';
const startOld = 'function disposeFocusFadeVeil()';
const end = '/**\n * Ensure blue focus ribbon exists';
const i1 = a.indexOf(start);
const i2 = a.indexOf(end, i1);
let j1 = b.indexOf(startOld);
if (j1 < 0) j1 = b.indexOf(start);
const j2 = b.indexOf(end, j1 > 0 ? j1 : 0);
if (i1 < 0 || i2 < 0 || j1 < 0 || j2 < 0) {
  console.error('markers', { i1, i2, j1, j2 });
  process.exit(1);
}
b = b.slice(0, j1) + a.slice(i1, i2) + b.slice(j2);

b = b.replace(
  /if \(!State\.gameSession\.gameStarted\) \{\r?\n\s*if \(cameraFocusRingMesh\) cameraFocusRingMesh\.visible = false;\r?\n(?:\s*if \(focusFadeVeil\) \{[\s\S]*?\}\r?\n)?\s*return;\r?\n\s*\}/,
  `if (!State.gameSession.gameStarted) {
    if (cameraFocusRingMesh) cameraFocusRingMesh.visible = false;
    FogVisual.setFocusFadeDisk(false, 0, 0, 1, 2);
    return;
  }`
);

fs.writeFileSync(dst, b);
console.log('Forest renderer focus-fade synced to FogVisual path');
