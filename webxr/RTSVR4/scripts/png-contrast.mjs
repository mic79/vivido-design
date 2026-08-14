import fs from 'node:fs';
import { chromium } from 'playwright';

const path = process.argv[2];
const buf = fs.readFileSync(path);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<img id="s" src="data:image/png;base64,${buf.toString('base64')}">`, { waitUntil: 'load' });
const r = await page.evaluate(() => {
  const img = document.getElementById('s');
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height).data;
  const lums = [];
  for (let i = 0; i < id.length; i += 4) {
    const a = id[i + 3];
    if (a < 8) continue;
    const lum = 0.2126 * id[i] + 0.7152 * id[i + 1] + 0.0722 * id[i + 2];
    lums.push(lum);
  }
  lums.sort((a, b) => a - b);
  const n = lums.length;
  const q = (p) => lums[Math.min(n - 1, Math.floor(p * n))];
  const avg = lums.reduce((s, v) => s + v, 0) / n;
  const crushed = lums.filter((v) => v < 8).length / n;
  const mid = lums.filter((v) => v >= 40 && v <= 160).length / n;
  const hot = lums.filter((v) => v >= 200).length / n;
  return {
    w: c.width,
    h: c.height,
    avg,
    p05: q(0.05),
    p20: q(0.2),
    p50: q(0.5),
    p80: q(0.8),
    p95: q(0.95),
    crushedFrac: crushed,
    midFrac: mid,
    hotFrac: hot,
    contrastP80P20: q(0.8) / Math.max(1, q(0.2)),
  };
});
console.log(path.split(/[/\\]/).pop(), JSON.stringify(r, null, 2));
await browser.close();
