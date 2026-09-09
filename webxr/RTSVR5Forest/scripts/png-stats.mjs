import fs from 'node:fs';
import { chromium } from 'playwright';

const path = process.argv[2];
const crop = process.argv.slice(3).map(Number);
const buf = fs.readFileSync(path);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<img id="s" src="data:image/png;base64,${buf.toString('base64')}">`, { waitUntil: 'load' });
const r = await page.evaluate((box) => {
  const img = document.getElementById('s');
  const c = document.createElement('canvas');
  const sx = box.length === 4 ? box[0] : 0;
  const sy = box.length === 4 ? box[1] : 0;
  const sw = box.length === 4 ? box[2] : img.naturalWidth;
  const sh = box.length === 4 ? box[3] : img.naturalHeight;
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const id = ctx.getImageData(0, 0, sw, sh).data;
  let sum = 0, n = 0, min = 255, max = 0;
  let black = 0, gray = 0, clip = 0;
  for (let i = 0; i < id.length; i += 4) {
    const lum = 0.2126 * id[i] + 0.7152 * id[i + 1] + 0.0722 * id[i + 2];
    sum += lum; n++;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    if (lum < 8) black++;
    else if (lum > 40 && lum < 160 && Math.abs(id[i] - id[i + 1]) < 18) gray++;
    if (lum >= 250) clip++;
  }
  const cx = Math.floor(sw * 0.5);
  const cy = Math.floor(sh * 0.5);
  const sample = ctx.getImageData(cx, cy, 8, 8).data;
  return {
    src: [img.naturalWidth, img.naturalHeight],
    crop: [sx, sy, sw, sh],
    avg: sum / n,
    min,
    max,
    blackFrac: black / n,
    grayFrac: gray / n,
    clipFrac: clip / n,
    centerRGBA: [sample[0], sample[1], sample[2], sample[3]],
  };
}, crop);
console.log(path, JSON.stringify(r, null, 2));
await browser.close();
