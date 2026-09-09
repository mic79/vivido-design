import fs from 'node:fs';
import { chromium } from 'playwright';

const buf = fs.readFileSync(
  'd:/backup 2024-04/Documents/Backup_MBP_2021-12/Backup/Projects/Apps/WebXR/RTSVR4/export/moon_01_diff_2k.jpg'
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(
  `<img id="s" src="data:image/jpeg;base64,${buf.toString('base64')}">`,
  { waitUntil: 'load' }
);
const r = await page.evaluate(() => {
  const img = document.getElementById('s');
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height).data;
  let s = 0,
    n = 0,
    min = 255,
    max = 0;
  for (let i = 0; i < id.length; i += 4) {
    const lum = 0.2126 * id[i] + 0.7152 * id[i + 1] + 0.0722 * id[i + 2];
    s += lum;
    n++;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  return { w: c.width, h: c.height, avg: s / n, min, max };
});
console.log(r);
await browser.close();
