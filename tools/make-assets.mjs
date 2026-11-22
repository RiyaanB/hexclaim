// Dev-only: regenerates docs/favicon-64.png, docs/icon-180.png and docs/og.png with headless Chrome.
// Usage: python3 -m http.server 8862 -d docs & node tools/make-assets.mjs 8862
import { chromium } from 'playwright';
import fs from 'node:fs';
const port = process.argv[2] || 8862;
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const svg = fs.readFileSync(new URL('../docs/favicon.svg', import.meta.url), 'utf8');
for (const [name, size] of [['favicon-64.png', 64], ['icon-180.png', 180]]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  const bg = name.startsWith('icon') ? '#0d1120' : 'transparent';
  await p.setContent(`<html><body style="margin:0;background:${bg}">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: new URL('../docs/' + name, import.meta.url).pathname, omitBackground: bg === 'transparent' });
  await p.close();
}
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.goto(`http://127.0.0.1:${port}/`);
await p.waitForTimeout(2600);
await p.evaluate(() => { document.querySelector('.title-links').style.display = 'none'; document.querySelector('.menu').style.display = 'none'; document.querySelector('.title-art').style.opacity = '0.55'; const t = document.querySelector('.tagline'); t.style.fontSize = '1.7rem'; t.textContent = 'Clone. Jump. Flip. Claim the board.'; document.querySelector('.logo').style.fontSize = '8rem'; document.querySelector('.title-inner').style.width = '1000px'; });
await p.waitForTimeout(300);
await p.screenshot({ path: new URL('../docs/og.png', import.meta.url).pathname });
await b.close();
console.log('assets written');
