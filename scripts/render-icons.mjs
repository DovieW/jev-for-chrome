// Render the shared SVG brand mark with Chromium; no image-library dependency.
// Run npm run icons after editing assets/icon.svg.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const svg = fs.readFileSync('assets/icon.svg', 'utf8');
const browser = await chromium.launch({
  channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent('<html><body style="margin:0"></body></html>');
  const renders = await page.evaluate(async (svg) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    await img.decode();
    const out = {};
    for (const [file, size, pad] of [
      ['public/icon16.png', 16, 0],
      ['public/icon32.png', 32, 0],
      ['public/icon48.png', 48, 0],
      ['public/icon128.png', 128, 16],
      ['assets/logo.png', 512, 0],
    ]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);
      out[file] = canvas.toDataURL('image/png');
    }
    return out;
  }, svg);
  for (const [file, dataUrl] of Object.entries(renders)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(file);
  }

  const logo = fs.readFileSync('assets/logo.png').toString('base64');
  for (const [file, w, h, size] of [
    ['docs/store/promo-440x280.png', 440, 280, 160],
    ['docs/store/promo-1400x560.png', 1400, 560, 300],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;background:#14171c">
      <img src="data:image/png;base64,${logo}" width="${size}" height="${size}" style="display:block">
    </body></html>`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} finally {
  await browser.close();
}
